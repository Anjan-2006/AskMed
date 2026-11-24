// routes/chat.js
import { Router } from 'express';
import multer from 'multer';
import { answerQuestion } from '../services/ragService.js';
import { answerBatch } from '../services/batchService.js';
import { retrieve } from '../services/retrieveService.js';
import { answerWithWebSearch } from '../services/webSearchService.js';
import { transcribeAudio } from '../services/transcribeService.js';
import { appendTurn, clearSession, getHistory, isValidSessionId } from '../services/sessionStore.js';

const router = Router();
const SCOPES = ['builtin', 'personal', 'both'];

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const ok =
      /^audio\//i.test(file.mimetype) ||
      file.mimetype === 'video/webm' ||
      /\.(webm|ogg|mp3|wav|m4a|mp4|flac)$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error('Unsupported audio format'), { status: 400 }), ok);
  },
});

function parseScopeAndTopK(body = {}) {
  const scope = (body.scope || 'both').toLowerCase();
  const topK = Math.min(Math.max(parseInt(body.topK, 10) || 5, 1), 10);
  if (!SCOPES.includes(scope)) throw Object.assign(new Error('"scope" must be builtin | personal | both'), { status: 400 });
  return { scope, topK };
}

function parseBody(body = {}) {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw Object.assign(new Error('"question" is required'), { status: 400 });
  if (question.length > 1000) throw Object.assign(new Error('"question" must be <= 1000 characters'), { status: 400 });
  let sessionId = null;
  if (body.sessionId != null && body.sessionId !== '') {
    if (!isValidSessionId(body.sessionId)) {
      throw Object.assign(new Error('"sessionId" must be 8-64 alphanumeric/underscore/hyphen characters'), { status: 400 });
    }
    sessionId = body.sessionId;
  }
  const history = Array.isArray(body.history) ? body.history : null;
  return { question, sessionId, history, ...parseScopeAndTopK(body) };
}

/** POST /api/chat  { question, scope?: builtin|personal|both, topK?: 1-10, sessionId?, history? } */
router.post('/', async (req, res, next) => {
  try {
    const { question, scope, topK, sessionId, history } = parseBody(req.body);
    const activeHistory = history ?? (sessionId ? getHistory(sessionId) : []);
    const result = await answerQuestion({ question, scope, topK, history: activeHistory });
    if (sessionId && result.answer) {
      appendTurn(sessionId, question, result.answer);
    }
    res.json(sessionId ? { sessionId, ...result } : result);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/chat/session/:sessionId - clear conversation history for a session */
router.delete('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }
  const cleared = clearSession(sessionId);
  res.json({ success: true, sessionId, cleared });
});

/**
 * POST /api/chat/batch
 * { questions: string[] | string, scope?: builtin|personal|both, topK?: 1-10, concurrency?: 1-5 }
 */
router.post('/batch', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { scope, topK } = parseScopeAndTopK(body);
    const concurrency = body.concurrency != null ? parseInt(body.concurrency, 10) : undefined;
    res.json(await answerBatch({ questions: body.questions, scope, topK, concurrency }));
  } catch (err) {
    next(err);
  }
});

/** POST /api/chat/web-search - consent-based Tavily web search + grounded LLM answer */
router.post('/web-search', async (req, res, next) => {
  try {
    const { question, sessionId, history } = parseBody(req.body);
    const activeHistory = history ?? (sessionId ? getHistory(sessionId) : []);
    const result = await answerWithWebSearch({ question, history: activeHistory });
    if (sessionId && result.answer) {
      appendTurn(sessionId, question, result.answer);
    }
    res.json(sessionId ? { sessionId, ...result } : result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/chat/transcribe - Whisper speech-to-text via Groq */
router.post('/transcribe', audioUpload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio recording received.' });
    }
    const result = await transcribeAudio({
      buffer: req.file.buffer,
      filename: req.file.originalname || 'recording.webm',
      mimetype: req.file.mimetype || 'audio/webm',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/chat/retrieve - IR only (no LLM). Shows dense/BM25/RRF/rerank scores for evaluation. */
router.post('/retrieve', async (req, res, next) => {
  try {
    const { question, scope, topK } = parseBody(req.body);
    res.json({ question, scope, ...(await retrieve(question, { scope, topK })) });
  } catch (err) {
    next(err);
  }
});

export default router;

