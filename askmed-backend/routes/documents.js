// routes/documents.js
import { Router } from 'express';
import multer from 'multer';
import { ingestPdf } from '../services/ingestService.js';
import { config, getIndex, getNamespace, getIndexMode } from '../config/clients.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error('Only PDF files are allowed'), { status: 400 }), ok);
  },
});

/**
 * POST /api/documents/ingest
 * multipart/form-data:
 *   file       (required) PDF
 *   namespace  builtin | personal   (default: personal)
 *   title, publisher, sourceUrl     (optional metadata, recommended for builtin docs)
 */
router.post('/ingest', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use form field "file".' });
    const namespace = (req.body.namespace || 'personal').toLowerCase();
    if (!config.namespaces.includes(namespace)) {
      return res.status(400).json({ error: 'namespace must be "builtin" or "personal"' });
    }
    const result = await ingestPdf({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      namespace,
      title: req.body.title,
      publisher: req.body.publisher,
      sourceUrl: req.body.sourceUrl,
    });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/stats - record counts per namespace */
router.get('/stats', async (_req, res, next) => {
  try {
    const stats = await (await getIndex()).describeIndexStats();
    res.json({ index: config.pinecone.indexName, ...stats });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/documents/personal - wipe the user's personal knowledge base (demo reset) */
router.delete('/personal', async (_req, res, next) => {
  try {
    const ns = await getNamespace('personal');
    if (getIndexMode() === 'documents') await ns.documents.delete({ deleteAll: true });
    else await ns.deleteAll();
    res.json({ success: true, message: 'Personal namespace cleared.' });
  } catch (err) {
    next(err);
  }
});

export default router;

