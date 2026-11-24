// services/pdfStorageService.js
// Stores, streams, and deletes raw PDF binaries in MongoDB GridFS (bucket: "pdfs")
// using Mongoose's built-in MongoDB driver — zero extra packages or credentials.
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';

const BUCKET_NAME = 'pdfs';

async function getBucket() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) {
    throw Object.assign(new Error('MongoDB connection is not ready for PDF storage'), { status: 503 });
  }
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

/**
 * Stream a PDF Buffer into MongoDB GridFS and return its string ObjectId.
 */
export async function savePdfToGridFS({ buffer, filename, metadata = {} }) {
  if (!buffer || !buffer.length) {
    throw Object.assign(new Error('Cannot store empty PDF buffer'), { status: 400 });
  }
  const bucket = await getBucket();
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename || 'document.pdf', {
      contentType: 'application/pdf',
      metadata,
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(String(uploadStream.id)));
    Readable.from(buffer).pipe(uploadStream);
  });
}

/**
 * Open a readable GridFS download stream for a stored PDF.
 */
export async function openPdfDownloadStream(gridFsFileId) {
  const { ObjectId } = mongoose.mongo;
  if (!gridFsFileId || !ObjectId.isValid(gridFsFileId)) {
    throw Object.assign(new Error('Stored PDF file not found'), { status: 404 });
  }
  const bucket = await getBucket();
  return bucket.openDownloadStream(new ObjectId(gridFsFileId));
}

/**
 * Delete a stored PDF from GridFS. Ignores already-deleted/missing files.
 */
export async function deletePdfFromGridFS(gridFsFileId) {
  const { ObjectId } = mongoose.mongo;
  if (!gridFsFileId || !ObjectId.isValid(gridFsFileId)) return;
  try {
    const bucket = await getBucket();
    await bucket.delete(new ObjectId(gridFsFileId));
  } catch (err) {
    if (/FileNotFound|not found/i.test(err?.message || '')) return;
    throw err;
  }
}

