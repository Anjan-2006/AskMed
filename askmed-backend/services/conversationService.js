// services/conversationService.js
// Device-scoped persistent conversation lifecycle + isolated per-conversation document RAG.
// No authentication: device isolation is enforced via deviceId on every read/write.
import { randomUUID } from 'node:crypto';
import { connectDB } from '../config/db.js';
import { deleteDocumentFromNamespace, deleteNamespace } from '../config/clients.js';
import { Conversation } from '../models/Conversation.js';
import { ingestPdf } from './ingestService.js';
import { deletePdfFromGridFS, openPdfDownloadStream, savePdfToGridFS } from './pdfStorageService.js';
import { answerQuestion } from './ragService.js';
import { answerWithWebSearch } from './webSearchService.js';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidDeviceId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function isValidConversationId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function assertDeviceId(deviceId) {
  if (!isValidDeviceId(deviceId)) {
    throw Object.assign(new Error('Missing or invalid device ID (x-device-id header)'), { status: 400 });
  }
}

function assertConversationId(conversationId) {
  if (!isValidConversationId(conversationId)) {
    throw Object.assign(new Error('Invalid conversation ID'), { status: 400 });
  }
}

function deriveTitle(question) {
  const clean = String(question || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  return clean.length <= 52 ? clean : `${clean.slice(0, 52).trimEnd()}…`;
}

function toSummary(doc) {
  return {
    conversationId: doc.conversationId,
    title: doc.title,
    status: doc.status,
    documents: (doc.documents || []).map((d) => ({
      docId: d.docId,
      filename: d.filename,
      title: d.title,
      sizeBytes: d.sizeBytes,
      totalPages: d.totalPages,
      status: d.status,
      hasFile: Boolean(d.gridFsFileId),
      uploadedAt: d.uploadedAt,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toDetail(doc) {
  return {
    ...toSummary(doc),
    messages: (doc.messages || []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      sourceType: m.sourceType,
      citations: m.citations || [],
      webSources: m.webSources || [],
      canSearchWeb: Boolean(m.canSearchWeb),
      webOfferDismissed: Boolean(m.webOfferDismissed),
      webSearchQuestion: m.webSearchQuestion,
      refused: Boolean(m.refused),
      grounded: Boolean(m.grounded),
    })),
  };
}

async function ensureDb(deps) {
  if (deps.ConversationModel) return;
  await connectDB();
}

export async function createConversation(deviceId, deps = {}) {
  assertDeviceId(deviceId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;

  const conversationId = randomUUID();
  const pineconeNamespace = `conv_${conversationId}`;
  const created = await Model.create({
    deviceId,
    conversationId,
    pineconeNamespace,
    title: 'New conversation',
    status: 'setup',
    documents: [],
    messages: [],
  });

  return toDetail(created);
}

/** Efficient sidebar listing: excludes full message bodies. */
export async function listConversations(deviceId, deps = {}) {
  assertDeviceId(deviceId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;

  // Only list conversations that have been started (or have messages/documents)
  const rows = await Model.find(
    { deviceId, $or: [{ status: 'active' }, { 'messages.0': { $exists: true } }] },
    { messages: 0 }
  )
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  return rows.map(toSummary);
}

export async function getConversation(deviceId, conversationId, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;

  const doc = await Model.findOne({ deviceId, conversationId }).lean();
  if (!doc) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  return toDetail(doc);
}

export async function uploadConversationDocument(
  deviceId,
  conversationId,
  { buffer, filename, mimetype = 'application/pdf', sizeBytes = 0, title },
  deps = {}
) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;
  const ingestFn = deps.ingestPdf || ingestPdf;
  const savePdfFn = deps.savePdfToGridFS || savePdfToGridFS;
  const deletePdfFn = deps.deletePdfFromGridFS || deletePdfFromGridFS;

  const conv = await Model.findOne({ deviceId, conversationId });
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const ingested = await ingestFn({
    buffer,
    filename,
    namespace: conv.pineconeNamespace,
    title,
    publisher: 'Uploaded document',
  });

  const gridFsFileId = await savePdfFn({
    buffer,
    filename,
    metadata: { deviceId, conversationId, docId: ingested.docId },
  });

  const record = {
    docId: ingested.docId,
    filename,
    title: ingested.title,
    mimeType: mimetype,
    sizeBytes: sizeBytes || buffer?.length || 0,
    totalPages: ingested.totalPages || 0,
    pagesIndexed: ingested.pagesIndexed || 0,
    chunksUpserted: ingested.chunksUpserted || 0,
    status: 'ready',
    error: '',
    pineconeNamespace: conv.pineconeNamespace,
    gridFsFileId,
    uploadedAt: new Date(),
  };

  // Replace if same docId re-uploaded into this conversation (cleaning up old GridFS file), else push
  const existingIdx = conv.documents.findIndex((d) => d.docId === record.docId);
  const previousGridFsId = existingIdx >= 0 ? conv.documents[existingIdx]?.gridFsFileId : '';
  if (existingIdx >= 0) conv.documents[existingIdx] = record;
  else conv.documents.push(record);

  try {
    await conv.save();
  } catch (err) {
    await deletePdfFn(gridFsFileId).catch(() => {});
    throw err;
  }

  if (previousGridFsId && previousGridFsId !== gridFsFileId) {
    await deletePdfFn(previousGridFsId).catch(() => {});
  }

  const { gridFsFileId: _omit, ...publicDoc } = record;
  return { document: { ...publicDoc, hasFile: Boolean(gridFsFileId) }, conversation: toSummary(conv) };
}

export async function removeConversationDocument(deviceId, conversationId, docId, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;
  const deleteDocFn = deps.deleteDocumentFromNamespace || deleteDocumentFromNamespace;
  const deletePdfFn = deps.deletePdfFromGridFS || deletePdfFromGridFS;

  const conv = await Model.findOne({ deviceId, conversationId });
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const idx = conv.documents.findIndex((d) => d.docId === docId);
  if (idx === -1) throw Object.assign(new Error('Document not found in this conversation'), { status: 404 });

  const target = conv.documents[idx];
  await deleteDocFn(conv.pineconeNamespace, docId);
  if (target.gridFsFileId) {
    await deletePdfFn(target.gridFsFileId);
  }
  conv.documents.splice(idx, 1);
  await conv.save();

  return { removed: true, docId, conversation: toSummary(conv) };
}

/**
 * Resolve and open a GridFS download stream for a document belonging to this device's conversation.
 */
export async function getConversationDocumentFile(deviceId, conversationId, docId, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;
  const openStreamFn = deps.openPdfDownloadStream || openPdfDownloadStream;

  const conv = await Model.findOne({ deviceId, conversationId }).lean();
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const doc = (conv.documents || []).find((d) => d.docId === docId);
  if (!doc || !doc.gridFsFileId) {
    throw Object.assign(new Error('PDF file not found for this document'), { status: 404 });
  }

  const stream = await openStreamFn(doc.gridFsFileId);
  return {
    filename: doc.filename || 'document.pdf',
    mimeType: doc.mimeType || 'application/pdf',
    sizeBytes: doc.sizeBytes || 0,
    stream,
  };
}

export async function startConversation(deviceId, conversationId, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;

  const conv = await Model.findOne({ deviceId, conversationId });
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const readyDocs = conv.documents.filter((d) => d.status === 'ready');
  if (!readyDocs.length) {
    throw Object.assign(new Error('Please upload at least one PDF document before starting a conversation.'), {
      status: 400,
    });
  }

  conv.status = 'active';
  await conv.save();
  return toDetail(conv);
}

export async function sendConversationMessage(deviceId, conversationId, { question }, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) throw Object.assign(new Error('"question" is required'), { status: 400 });
  if (q.length > 1000) throw Object.assign(new Error('"question" must be <= 1000 characters'), { status: 400 });

  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;
  const answerFn = deps.answerQuestion || answerQuestion;

  const conv = await Model.findOne({ deviceId, conversationId });
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const history = conv.messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
  const result = await answerFn({
    question: q,
    scope: conv.pineconeNamespace,
    history,
  });

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: q,
    createdAt: Date.now(),
  };

  const assistantMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: result.answer,
    createdAt: Date.now(),
    sourceType: result.sourceType ?? (result.mode === 'rag' ? 'documents' : result.mode === 'guard' ? 'guard' : 'chat'),
    citations: result.citations || [],
    webSources: result.webSources || [],
    canSearchWeb: Boolean(result.canSearchWeb),
    webOfferDismissed: false,
    webSearchQuestion: result.canSearchWeb ? q : undefined,
    refused: Boolean(result.refused),
    grounded: Boolean(result.grounded),
  };

  if (conv.status !== 'active') conv.status = 'active';
  if (conv.title === 'New conversation' && q.length > 2) {
    conv.title = deriveTitle(q);
  }
  conv.messages.push(userMessage, assistantMessage);
  await conv.save();

  return {
    conversationId: conv.conversationId,
    title: conv.title,
    userMessage,
    assistantMessage,
    meta: {
      mode: result.mode,
      intent: result.intent,
      refused: result.refused,
      canSearchWeb: result.canSearchWeb,
      grounded: result.grounded,
    },
  };
}

export async function runConversationWebSearch(deviceId, conversationId, { question, messageId }, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) throw Object.assign(new Error('"question" is required'), { status: 400 });

  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;
  const webSearchFn = deps.answerWithWebSearch || answerWithWebSearch;

  const conv = await Model.findOne({ deviceId, conversationId });
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const history = conv.messages.slice(-8).map((m) => ({ role: m.role, content: m.content }));
  const result = await webSearchFn({ question: q, history });

  if (messageId) {
    const refusalMsg = conv.messages.find((m) => m.id === messageId);
    if (refusalMsg) refusalMsg.webOfferDismissed = true;
  }

  const assistantMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: result.answer,
    createdAt: Date.now(),
    sourceType: result.sourceType || 'web',
    citations: [],
    webSources: result.webSources || [],
    canSearchWeb: false,
    webOfferDismissed: false,
    refused: Boolean(result.refused),
    grounded: Boolean(result.grounded),
  };

  conv.messages.push(assistantMessage);
  await conv.save();

  return {
    conversationId: conv.conversationId,
    assistantMessage,
  };
}

export async function dismissConversationWebOffer(deviceId, conversationId, messageId, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;

  const conv = await Model.findOne({ deviceId, conversationId });
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const msg = conv.messages.find((m) => m.id === messageId);
  if (msg) {
    msg.webOfferDismissed = true;
    await conv.save();
  }
  return { success: true, messageId };
}

export async function renameConversation(deviceId, conversationId, title, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  const clean = typeof title === 'string' ? title.trim().slice(0, 80) : '';
  if (!clean) throw Object.assign(new Error('"title" is required'), { status: 400 });

  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;

  const conv = await Model.findOneAndUpdate(
    { deviceId, conversationId },
    { $set: { title: clean } },
    { new: true }
  ).lean();
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  return toSummary(conv);
}

export async function deleteConversation(deviceId, conversationId, deps = {}) {
  assertDeviceId(deviceId);
  assertConversationId(conversationId);
  await ensureDb(deps);
  const Model = deps.ConversationModel || Conversation;
  const deleteNsFn = deps.deleteNamespace || deleteNamespace;
  const deletePdfFn = deps.deletePdfFromGridFS || deletePdfFromGridFS;

  const conv = await Model.findOneAndDelete({ deviceId, conversationId }).lean();
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  // Clean up isolated Pinecone namespace and all stored GridFS PDFs for this conversation only
  await deleteNsFn(conv.pineconeNamespace);
  const fileIds = (conv.documents || []).map((d) => d.gridFsFileId).filter(Boolean);
  await Promise.all(fileIds.map((id) => deletePdfFn(id).catch(() => {})));
  return { success: true, conversationId };
}

