// server.js - AskMed Advanced RAG backend
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config, ensureIndex, getGroq } from './config/clients.js';
import { connectDB, isDbConnected, isMongoConfigured } from './config/db.js';
import documentsRouter from './routes/documents.js';
import chatRouter from './routes/chat.js';
import conversationsRouter from './routes/conversations.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/', (_req, res) =>
  res.json({
    name: 'AskMed - Conversational AI & Document RAG Assistant',
    endpoints: {
      'GET  /api/health': 'Pinecone + Groq + MongoDB connectivity',
      'POST /api/conversations': 'Create a new device-scoped conversation',
      'GET  /api/conversations': 'List conversations for x-device-id',
      'GET  /api/conversations/:id': 'Restore a conversation and its documents',
      'POST /api/conversations/:id/documents': 'Upload a PDF into this conversation',
      'POST /api/conversations/:id/start': 'Start conversation once documents are ready',
      'POST /api/conversations/:id/messages': 'Send a message to this conversation',
      'POST /api/conversations/:id/web-search': 'Consent-based healthcare web search',
      'DELETE /api/conversations/:id': 'Delete conversation and its isolated vectors',
      'POST /api/documents/ingest': 'multipart: file=<pdf>, namespace=builtin|personal, title?, publisher?, sourceUrl?',
      'GET  /api/documents/stats': 'Vector counts per namespace',
      'DELETE /api/documents/personal': 'Clear personal namespace',
      'POST /api/chat': '{ question, scope: builtin|personal|both, topK?, sessionId?, history? }',
      'POST /api/chat/web-search': '{ question, sessionId?, history? } (consent-based Tavily web search)',
      'POST /api/chat/transcribe': 'multipart: audio=<recording> (Groq Whisper speech-to-text)',
      'DELETE /api/chat/session/:sessionId': 'Clear active chat session history',
      'POST /api/chat/batch': '{ questions: string[] | multiline string, scope?, topK?, concurrency? }',
      'POST /api/chat/retrieve': 'Retrieval only (no LLM), shows all IR scores',
    },
  })
);

app.get('/api/health', async (_req, res) => {
  const health = { status: 'ok', pinecone: {}, groq: {}, mongodb: {} };
  try {
    const desc = await ensureIndex();
    health.pinecone = { ok: true, index: desc.name, mode: desc.mode, embed: desc.embedModel, fullTextFields: desc.fullTextFields, ready: desc.status?.ready };
  } catch (e) {
    health.status = 'degraded';
    health.pinecone = { ok: false, error: e.message };
  }
  try {
    const { data } = await getGroq().models.list();
    const ok = data.some((m) => m.id === config.groq.model);
    health.groq = { ok, model: config.groq.model };
    if (!ok) {
      health.status = 'degraded';
      health.groq.error = `Model "${config.groq.model}" not available on your Groq account`;
    }
  } catch (e) {
    health.status = 'degraded';
    health.groq = { ok: false, model: config.groq.model, error: e.message };
  }
  if (!isMongoConfigured()) {
    health.mongodb = { ok: false, configured: false, error: 'MONGODB_URI is not set in .env' };
  } else if (isDbConnected()) {
    health.mongodb = { ok: true, configured: true };
  } else {
    try {
      await connectDB();
      health.mongodb = { ok: true, configured: true };
    } catch (e) {
      health.status = 'degraded';
      health.mongodb = { ok: false, configured: true, error: 'Unable to connect to MongoDB Atlas' };
    }
  }
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.use('/api/conversations', conversationsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/chat', chatRouter);

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` }));

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal server error';
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = 'File too large (max 25 MB)';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  } else if (err.name === 'RateLimitError' || err.status === 429) {
    status = 429;
    message = `Groq rate limit hit, retry shortly: ${message}`;
  } else if (err.name === 'APIConnectionTimeoutError' || err.status === 408 || /timed?\s*out/i.test(message)) {
    status = 504;
    message = `Groq request timed out, please retry: ${message}`;
  } else if (err.name === 'AuthenticationError') {
    status = 503;
    message = 'Groq authentication failed - check GROQ_API_KEY in .env';
  } else if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    status = 503;
    message = `Upstream service unreachable: ${message}`;
  }
  console.error(`[error] ${status}: ${message}`);
  if (status === 500) console.error(err.stack);
  res.status(status).json({ error: message });
});

app.listen(config.port, async (err) => {
  if (err) {
    console.error(`[server] Failed to bind port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`AskMed backend listening on http://localhost:${config.port}`);
  try {
    const desc = await ensureIndex();
    console.log(`[pinecone] Connected to index "${desc.name}" (mode: ${desc.mode}, embed: ${desc.embedModel}, full-text: ${desc.fullTextFields.join(', ') || 'none'})`);
  } catch (e) {
    console.warn(`[pinecone] Not initialised yet: ${e.message}`);
  }
  if (isMongoConfigured()) {
    try {
      await connectDB();
    } catch {
      console.warn('[mongodb] Not connected yet (check MONGODB_URI in .env)');
    }
  } else {
    console.warn('[mongodb] MONGODB_URI not configured yet in .env');
  }
});

