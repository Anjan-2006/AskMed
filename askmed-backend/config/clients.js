// config/clients.js
// Central place for external clients (Pinecone vector DB + Groq LLM)
// and the Pinecone index bootstrap helper.
import 'dotenv/config';
import { Pinecone } from '@pinecone-database/pinecone';
import Groq from 'groq-sdk';

export const config = {
  port: Number(process.env.PORT) || 5000,
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY,
    indexName: process.env.PINECONE_INDEX_NAME || 'askmed-kb',
    cloud: process.env.PINECONE_CLOUD || 'aws',
    region: process.env.PINECONE_REGION || 'us-east-1',
    embedModel: 'llama-text-embed-v2',
    rerankModel: 'bge-reranker-v2-m3',
    textField: 'chunk_text',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
    timeoutMs: Number(process.env.GROQ_TIMEOUT_MS || 60000),
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY || '',
    maxResults: Math.min(Math.max(Number(process.env.TAVILY_MAX_RESULTS) || 5, 1), 10),
    timeoutMs: Number(process.env.TAVILY_TIMEOUT_MS || 20000),
  },
  rag: {
    minRelevanceScore: Number(process.env.MIN_RELEVANCE_SCORE ?? 0.15),
  },
  batch: {
    concurrency: Math.min(Math.max(Number(process.env.BATCH_CONCURRENCY) || 2, 1), 5),
    maxQuestions: Math.min(Math.max(Number(process.env.BATCH_MAX_QUESTIONS) || 20, 1), 50),
  },
  namespaces: ['builtin', 'personal'],
};

const isPlaceholderKey =
  !config.pinecone.apiKey || config.pinecone.apiKey.startsWith('REPLACE_WITH');

// Lazily constructed so the server can still boot (and report a clear
// error on /api/health) when the key has not been filled in yet.
let _pc = null;
export function getPinecone() {
  if (isPlaceholderKey) {
    const err = new Error('PINECONE_API_KEY is not set. Fill it in askmed-backend/.env');
    err.status = 503;
    throw err;
  }
  if (!_pc) _pc = new Pinecone({ apiKey: config.pinecone.apiKey });
  return _pc;
}

let _groq = null;
export function getGroq() {
  if (!config.groq.apiKey || config.groq.apiKey.startsWith('REPLACE_WITH')) {
    const err = new Error('GROQ_API_KEY is not set. Fill it in askmed-backend/.env');
    err.status = 503;
    throw err;
  }
  if (!_groq) {
    _groq = new Groq({
      apiKey: config.groq.apiKey,
      timeout: config.groq.timeoutMs,
      maxRetries: 2,
    });
  }
  return _groq;
}

let _indexHost = null;
let _indexMode = null; // 'documents' (schema-based index, API 2026-07+) | 'records' (legacy integrated index)

/** Which write/search API the connected index uses. */
export function getIndexMode() {
  return _indexMode;
}
let _fullTextFields = [];
/** Schema fields with full-text (BM25) search enabled, e.g. ['chunk_text', 'title']. */
export function getFullTextFields() {
  return _fullTextFields;
}

/**
 * Ensure the serverless index exists and has integrated llama-text-embed-v2 embedding on `chunk_text`.
 * Supports both:
 *  - schema-based "document" indexes (dense embed + full-text search fields, created in the new console), and
 *  - legacy integrated indexes (createForModel with fieldMap.text = chunk_text).
 * If the index does not exist, it is created as a legacy integrated index.
 */
export async function ensureIndex() {
  const pc = getPinecone();
  const { indexName, cloud, region, embedModel, textField } = config.pinecone;

  const { indexes = [] } = await pc.listIndexes();
  if (!indexes.some((i) => i.name === indexName)) {
    console.log(`[pinecone] Creating index "${indexName}" (${embedModel}, ${cloud}/${region})...`);
    await pc.indexes.createForModel({
      name: indexName,
      cloud,
      region,
      embed: { model: embedModel, fieldMap: { text: textField } },
      waitUntilReady: true,
    });
    console.log(`[pinecone] Index "${indexName}" is ready.`);
  }

  const desc = await pc.describeIndex(indexName);
  const schemaField = desc.schema?.fields?.[textField];

  if (schemaField?.embed) {
    _indexMode = 'documents';
    desc.embedModel = schemaField.embed.model;
    desc.fullTextFields = Object.entries(desc.schema.fields)
      .filter(([, f]) => f.fullTextSearch)
      .map(([name]) => name);
  } else if (desc.embed) {
    _indexMode = 'records';
    desc.embedModel = desc.embed.model;
    desc.fullTextFields = [];
  } else {
    const err = new Error(
      `Index "${indexName}" has no integrated embedding on field "${textField}". ` +
        `Add a "${textField}" string field with dense embedding (${embedModel}) in the Pinecone console, ` +
        'or delete the index / set a new PINECONE_INDEX_NAME and restart so AskMed can create it.'
    );
    err.status = 503;
    throw err;
  }
  desc.mode = _indexMode;
  _fullTextFields = desc.fullTextFields;
  _indexHost = desc.host;
  return desc;
}

const CONV_NS_RE = /^conv_[a-zA-Z0-9_-]{8,64}$/;

export function isValidNamespace(namespace) {
  return config.namespaces.includes(namespace) || CONV_NS_RE.test(namespace);
}

/** Get a namespace-scoped handle to the index (supports builtin, personal, and conv_<id>). */
export async function getNamespace(namespace) {
  if (!isValidNamespace(namespace)) {
    const err = new Error(`Invalid namespace "${namespace}". Use one of: ${config.namespaces.join(', ')} or conv_<id>`);
    err.status = 400;
    throw err;
  }
  if (!_indexHost) await ensureIndex();
  return getPinecone().index({ name: config.pinecone.indexName, host: _indexHost, namespace });
}

/** Delete all records in a namespace (used when deleting a conversation). */
export async function deleteNamespace(namespace) {
  if (!isValidNamespace(namespace)) return;
  try {
    const ns = await getNamespace(namespace);
    if (_indexMode === 'documents') await ns.documents.delete({ deleteAll: true });
    else await ns.deleteAll();
  } catch (err) {
    if (err?.name === 'PineconeNotFoundError' || /not found|does not exist/i.test(err?.message || '')) return;
    throw err;
  }
}

/** Delete a single document's chunks from a conversation namespace by doc_id. */
export async function deleteDocumentFromNamespace(namespace, docId) {
  if (!isValidNamespace(namespace) || !docId) return;
  try {
    const ns = await getNamespace(namespace);
    if (_indexMode === 'documents') {
      await ns.documents.delete({ filter: { doc_id: { $eq: docId } } });
    } else {
      await ns.deleteMany({ doc_id: { $eq: docId } });
    }
  } catch (err) {
    if (err?.name === 'PineconeNotFoundError' || /not found|does not exist/i.test(err?.message || '')) return;
    throw err;
  }
}

/** Index-level handle (for stats). */
export async function getIndex() {
  if (!_indexHost) await ensureIndex();
  return getPinecone().index({ name: config.pinecone.indexName, host: _indexHost });
}
