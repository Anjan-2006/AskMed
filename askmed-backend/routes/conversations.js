// routes/conversations.js
// Device-scoped persistent conversation & document-upload routes (no user accounts/auth).
import { Router } from 'express';
import multer from 'multer';
import {
  createConversation,
  deleteConversation,
  dismissConversationWebOffer,
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

const router = Router();

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error('Only PDF files are supported'), { status: 400 }), ok);
  },
});

const getDeviceId = (req) => req.header('x-device-id') || req.query?.deviceId || req.body?.deviceId || '';

/** POST /api/conversations - create a fresh conversation in setup mode */
router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await createConversation(getDeviceId(req)));
  } catch (err) {
    next(err);
  }
});

/** GET /api/conversations - list conversations for this device (no full message bodies) */
router.get('/', async (req, res, next) => {
  try {
    res.json({ conversations: await listConversations(getDeviceId(req)) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/conversations/:id - restore full conversation (messages + documents) */
router.get('/:id', async (req, res, next) => {
  try {
    res.json(await getConversation(getDeviceId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

/** POST /api/conversations/:id/documents - upload a PDF into this conversation's isolated namespace */
router.post('/:id/documents', pdfUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded. Use form field "file".' });
    const result = await uploadConversationDocument(getDeviceId(req), req.params.id, {
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      sizeBytes: req.file.size,
      title: req.body?.title,
    });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/conversations/:id/documents/:docId/file - stream stored PDF inline (supports #page=N in browser) */
router.get('/:id/documents/:docId/file', async (req, res, next) => {
  try {
    const { filename, mimeType, stream } = await getConversationDocumentFile(
      getDeviceId(req),
      req.params.id,
      req.params.docId
    );
    const safeName = filename.replace(/["\\\r\n]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.on('error', (err) => {
      if (!res.headersSent) {
        next(Object.assign(new Error('Stored PDF file could not be read'), { status: 404, cause: err }));
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/conversations/:id/documents/:docId - remove a document from this conversation */
router.delete('/:id/documents/:docId', async (req, res, next) => {
  try {
    res.json(await removeConversationDocument(getDeviceId(req), req.params.id, req.params.docId));
  } catch (err) {
    next(err);
  }
});

/** POST /api/conversations/:id/start - mark conversation active once >= 1 PDF is ready */
router.post('/:id/start', async (req, res, next) => {
  try {
    res.json(await startConversation(getDeviceId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

/** POST /api/conversations/:id/messages - ask a question grounded in this conversation's documents */
router.post('/:id/messages', async (req, res, next) => {
  try {
    res.json(
      await sendConversationMessage(getDeviceId(req), req.params.id, {
        question: req.body?.question,
      })
    );
  } catch (err) {
    next(err);
  }
});

/** POST /api/conversations/:id/web-search - explicit consent web search for a healthcare question */
router.post('/:id/web-search', async (req, res, next) => {
  try {
    res.json(
      await runConversationWebSearch(getDeviceId(req), req.params.id, {
        question: req.body?.question,
        messageId: req.body?.messageId,
      })
    );
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/conversations/:id/messages/:messageId/dismiss-web - keep document-only */
router.patch('/:id/messages/:messageId/dismiss-web', async (req, res, next) => {
  try {
    res.json(await dismissConversationWebOffer(getDeviceId(req), req.params.id, req.params.messageId));
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/conversations/:id - rename conversation */
router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await renameConversation(getDeviceId(req), req.params.id, req.body?.title));
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/conversations/:id - delete conversation + clean up isolated Pinecone namespace */
router.delete('/:id', async (req, res, next) => {
  try {
    res.json(await deleteConversation(getDeviceId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;

