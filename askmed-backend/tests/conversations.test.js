import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createConversation,
  deleteConversation,
  getConversation,
  getConversationDocumentFile,
  listConversations,
  removeConversationDocument,
  renameConversation,
  runConversationWebSearch,
  sendConversationMessage,
  startConversation,
  uploadConversationDocument,
} from '../services/conversationService.js';
import { resolveNamespaces } from '../services/retrieveService.js';

/** Minimal in-memory Mongoose-like model stub for fast, deterministic persistence tests. */
function createMockModel() {
  const store = [];

  function wrapDoc(raw) {
    const doc = {
      ...raw,
      documents: [...(raw.documents || [])],
      messages: [...(raw.messages || [])],
      async save() {
        this.updatedAt = new Date();
        const idx = store.findIndex((r) => r.conversationId === this.conversationId);
        if (idx >= 0) store[idx] = { ...this };
        else store.push({ ...this });
        return this;
      },
    };
    return doc;
  }

  return {
    _store: store,
    async create(data) {
      const now = new Date();
      const rec = { ...data, createdAt: now, updatedAt: now };
      store.push(rec);
      return wrapDoc(rec);
    },
    find(query, projection = {}) {
      const matches = store.filter((r) => {
        if (query.deviceId && r.deviceId !== query.deviceId) return false;
        if (query.$or) {
          const ok = query.$or.some((cond) => {
            if (cond.status && r.status === cond.status) return true;
            if (cond['messages.0']?.$exists && r.messages.length > 0) return true;
            return false;
          });
          if (!ok) return false;
        }
        return true;
      });
      const chain = {
        sort() {
          matches.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
          return chain;
        },
        limit(n) {
          matches.splice(n);
          return chain;
        },
        async lean() {
          return matches.map((m) => {
            const copy = { ...m };
            if (projection.messages === 0) delete copy.messages;
            return copy;
          });
        },
      };
      return chain;
    },
    findOne(query) {
      const found = store.find(
        (r) => r.deviceId === query.deviceId && r.conversationId === query.conversationId
      );
      const doc = found ? wrapDoc(found) : null;
      if (!doc) {
        const p = Promise.resolve(null);
        p.lean = async () => null;
        return p;
      }
      const p = Promise.resolve(doc);
      p.lean = async () => ({ ...found });
      return p;
    },
    findOneAndUpdate(query, update) {
      const idx = store.findIndex(
        (r) => r.deviceId === query.deviceId && r.conversationId === query.conversationId
      );
      const updated = idx >= 0 ? { ...store[idx], ...update.$set, updatedAt: new Date() } : null;
      if (idx >= 0) store[idx] = updated;
      return { lean: async () => (updated ? { ...updated } : null) };
    },
    findOneAndDelete(query) {
      const idx = store.findIndex(
        (r) => r.deviceId === query.deviceId && r.conversationId === query.conversationId
      );
      const deleted = idx >= 0 ? store.splice(idx, 1)[0] : null;
      return { lean: async () => (deleted ? { ...deleted } : null) };
    },
  };
}

const DEVICE_A = '11111111-aaaa-4bbb-8ccc-111111111111';
const DEVICE_B = '22222222-aaaa-4bbb-8ccc-222222222222';

test('conversation lifecycle: create -> upload PDF -> start -> message -> restore with citations', async () => {
  const Model = createMockModel();
  const ingestedNamespaces = [];
  const ragScopes = [];

  const conv = await createConversation(DEVICE_A, { ConversationModel: Model });
  assert.equal(conv.status, 'setup');
  assert.equal(conv.documents.length, 0);

  // Cannot start without at least one uploaded document
  await assert.rejects(
    () => startConversation(DEVICE_A, conv.conversationId, { ConversationModel: Model }),
    (err) => err.status === 400
  );

  // Upload PDF into conversation-specific isolated namespace + GridFS
  const uploaded = await uploadConversationDocument(
    DEVICE_A,
    conv.conversationId,
    { buffer: Buffer.from('%PDF-1.4'), filename: 'who_diet.pdf', sizeBytes: 4096 },
    {
      ConversationModel: Model,
      savePdfToGridFS: async () => '65f000000000000000000001',
      ingestPdf: async ({ namespace, filename }) => {
        ingestedNamespaces.push(namespace);
        return {
          docId: `${namespace}-who-diet`,
          title: 'WHO Healthy Diets',
          filename,
          totalPages: 12,
          pagesIndexed: 12,
          chunksUpserted: 24,
        };
      },
    }
  );
  assert.equal(ingestedNamespaces[0], `conv_${conv.conversationId}`);
  assert.equal(uploaded.document.status, 'ready');
  assert.equal(uploaded.document.hasFile, true);
  assert.equal('gridFsFileId' in uploaded.document, false);
  assert.deepEqual(resolveNamespaces(`conv_${conv.conversationId}`), [`conv_${conv.conversationId}`]);

  // Start conversation
  const active = await startConversation(DEVICE_A, conv.conversationId, { ConversationModel: Model });
  assert.equal(active.status, 'active');

  // Send message -> uses ONLY conv_<id> namespace and persists citations + derived title
  const msgRes = await sendConversationMessage(
    DEVICE_A,
    conv.conversationId,
    { question: 'What are the four core principles of healthy diets?' },
    {
      ConversationModel: Model,
      answerQuestion: async ({ scope }) => {
        ragScopes.push(scope);
        return {
          mode: 'rag',
          sourceType: 'documents',
          intent: 'document_query',
          refused: false,
          canSearchWeb: false,
          grounded: true,
          answer: 'Adequate, balanced, moderate, and diverse [WHO Healthy Diets, p. 9].',
          citations: [{ citation: '[WHO Healthy Diets, p. 9]', title: 'WHO Healthy Diets', page: 9 }],
        };
      },
    }
  );
  assert.equal(ragScopes[0], `conv_${conv.conversationId}`);
  assert.equal(msgRes.title, 'What are the four core principles of healthy diets?');

  // Restore full conversation (simulating page reload / backend restart)
  const restored = await getConversation(DEVICE_A, conv.conversationId, { ConversationModel: Model });
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].citations[0].citation, '[WHO Healthy Diets, p. 9]');
  assert.equal(restored.documents.length, 1);

  // List conversations for Device A (sidebar projection excludes messages)
  const listed = await listConversations(DEVICE_A, { ConversationModel: Model });
  assert.equal(listed.length, 1);
  assert.equal('messages' in listed[0], false);
  assert.equal(listed[0].documents.length, 1);
});

test('new conversation has isolated namespace and Device A cannot access Device B conversations', async () => {
  const Model = createMockModel();
  const deletedNamespaces = [];

  const convA = await createConversation(DEVICE_A, { ConversationModel: Model });
  const convA2 = await createConversation(DEVICE_A, { ConversationModel: Model });
  const convB = await createConversation(DEVICE_B, { ConversationModel: Model });

  assert.notEqual(convA.conversationId, convA2.conversationId);
  assert.equal(convA2.documents.length, 0);

  // Device B cannot read, rename, or delete Device A's conversation
  await assert.rejects(
    () => getConversation(DEVICE_B, convA.conversationId, { ConversationModel: Model }),
    (err) => err.status === 404
  );
  await assert.rejects(
    () => renameConversation(DEVICE_B, convA.conversationId, 'Hacked', { ConversationModel: Model }),
    (err) => err.status === 404
  );
  await assert.rejects(
    () => deleteConversation(DEVICE_B, convA.conversationId, { ConversationModel: Model }),
    (err) => err.status === 404
  );

  // Device A deleting convA cleans up ONLY conv_<convA.conversationId>
  await deleteConversation(DEVICE_A, convA.conversationId, {
    ConversationModel: Model,
    deleteNamespace: async (ns) => deletedNamespaces.push(ns),
  });
  assert.deepEqual(deletedNamespaces, [`conv_${convA.conversationId}`]);

  // Device B's conversation is completely untouched
  const stillB = await getConversation(DEVICE_B, convB.conversationId, { ConversationModel: Model });
  assert.equal(stillB.conversationId, convB.conversationId);
});

test('removing a document before starting cleans up only that doc and web search persists sources', async () => {
  const Model = createMockModel();
  const removedDocs = [];
  const conv = await createConversation(DEVICE_A, { ConversationModel: Model });

  const up = await uploadConversationDocument(
    DEVICE_A,
    conv.conversationId,
    { buffer: Buffer.from('%PDF'), filename: 'report.pdf', sizeBytes: 1200 },
    {
      ConversationModel: Model,
      savePdfToGridFS: async () => '65f000000000000000000002',
      ingestPdf: async ({ namespace, filename }) => ({
        docId: `${namespace}-report`,
        title: 'Report',
        filename,
        totalPages: 3,
        pagesIndexed: 3,
        chunksUpserted: 5,
      }),
    }
  );

  const deletedGridFsIds = [];
  await removeConversationDocument(DEVICE_A, conv.conversationId, up.document.docId, {
    ConversationModel: Model,
    deleteDocumentFromNamespace: async (ns, id) => removedDocs.push([ns, id]),
    deletePdfFromGridFS: async (id) => deletedGridFsIds.push(id),
  });
  assert.deepEqual(removedDocs, [[`conv_${conv.conversationId}`, up.document.docId]]);
  assert.deepEqual(deletedGridFsIds, ['65f000000000000000000002']);

  // Consent-based web search persists webSources onto the conversation
  const web = await runConversationWebSearch(
    DEVICE_A,
    conv.conversationId,
    { question: 'What are early symptoms of Lyme disease?' },
    {
      ConversationModel: Model,
      answerWithWebSearch: async () => ({
        mode: 'web',
        sourceType: 'web',
        refused: false,
        grounded: true,
        answer: 'Early symptoms include fever and a bullseye rash.',
        webSources: [{ title: 'CDC Lyme', url: 'https://www.cdc.gov/lyme', domain: 'cdc.gov' }],
      }),
    }
  );
  assert.equal(web.assistantMessage.sourceType, 'web');
  assert.equal(web.assistantMessage.webSources[0].domain, 'cdc.gov');
});

test('GridFS PDF streaming enforces device isolation and conversation deletion cleans up all stored PDFs', async () => {
  const Model = createMockModel();
  const savedFiles = new Map();
  const deletedGridFs = [];
  const deletedNamespaces = [];

  const conv = await createConversation(DEVICE_A, { ConversationModel: Model });

  const uploadOne = (filename, gridId) =>
    uploadConversationDocument(
      DEVICE_A,
      conv.conversationId,
      { buffer: Buffer.from(`%PDF-${filename}`), filename, sizeBytes: 100 },
      {
        ConversationModel: Model,
        savePdfToGridFS: async ({ buffer }) => {
          savedFiles.set(gridId, buffer);
          return gridId;
        },
        ingestPdf: async ({ namespace, filename: fn }) => ({
          docId: `${namespace}-${fn.replace('.pdf', '')}`,
          title: fn.replace('.pdf', ''),
          filename: fn,
          totalPages: 5,
          pagesIndexed: 5,
          chunksUpserted: 8,
        }),
      }
    );

  const d1 = await uploadOne('doc1.pdf', '65f000000000000000000011');
  await uploadOne('doc2.pdf', '65f000000000000000000012');

  // Device A can stream its own stored PDF
  const fileRes = await getConversationDocumentFile(DEVICE_A, conv.conversationId, d1.document.docId, {
    ConversationModel: Model,
    openPdfDownloadStream: async (id) => Readable.from(savedFiles.get(id)),
  });
  assert.equal(fileRes.filename, 'doc1.pdf');
  assert.equal(fileRes.mimeType, 'application/pdf');
  const chunks = [];
  for await (const c of fileRes.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), '%PDF-doc1.pdf');

  // Device B is blocked (404) from streaming Device A's PDF
  await assert.rejects(
    () =>
      getConversationDocumentFile(DEVICE_B, conv.conversationId, d1.document.docId, {
        ConversationModel: Model,
        openPdfDownloadStream: async (id) => Readable.from(savedFiles.get(id)),
      }),
    (err) => err.status === 404
  );

  // Deleting conversation removes BOTH GridFS PDFs and the isolated Pinecone namespace
  await deleteConversation(DEVICE_A, conv.conversationId, {
    ConversationModel: Model,
    deleteNamespace: async (ns) => deletedNamespaces.push(ns),
    deletePdfFromGridFS: async (id) => deletedGridFs.push(id),
  });
  assert.deepEqual(deletedNamespaces, [`conv_${conv.conversationId}`]);
  assert.deepEqual(deletedGridFs.sort(), ['65f000000000000000000011', '65f000000000000000000012']);
});

