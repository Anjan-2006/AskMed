// models/Conversation.js
// Persistent, device-scoped conversation model for AskMed (no user accounts/auth).
import mongoose from 'mongoose';

const CitationSchema = new mongoose.Schema(
  {
    citation: String,
    title: String,
    page: Number,
    namespace: String,
    publisher: String,
    sourceUrl: String,
  },
  { _id: false }
);

const WebSourceSchema = new mongoose.Schema(
  {
    title: String,
    url: String,
    domain: String,
  },
  { _id: false }
);

const DocumentRecordSchema = new mongoose.Schema(
  {
    docId: { type: String, required: true },
    filename: { type: String, required: true },
    title: { type: String, required: true },
    mimeType: { type: String, default: 'application/pdf' },
    sizeBytes: { type: Number, default: 0 },
    totalPages: { type: Number, default: 0 },
    pagesIndexed: { type: Number, default: 0 },
    chunksUpserted: { type: Number, default: 0 },
    status: { type: String, enum: ['processing', 'ready', 'error'], default: 'ready' },
    error: { type: String, default: '' },
    pineconeNamespace: { type: String, required: true },
    gridFsFileId: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Number, default: () => Date.now() },
    sourceType: { type: String, enum: ['documents', 'web', 'chat', 'guard'] },
    citations: { type: [CitationSchema], default: [] },
    webSources: { type: [WebSourceSchema], default: [] },
    canSearchWeb: { type: Boolean, default: false },
    webOfferDismissed: { type: Boolean, default: false },
    webSearchQuestion: { type: String },
    refused: { type: Boolean, default: false },
    grounded: { type: Boolean, default: false },
  },
  { _id: false }
);

const ConversationSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, unique: true, index: true },
    pineconeNamespace: { type: String, required: true },
    title: { type: String, default: 'New conversation' },
    status: { type: String, enum: ['setup', 'active'], default: 'setup' },
    documents: { type: [DocumentRecordSchema], default: [] },
    messages: { type: [MessageSchema], default: [] },
  },
  { timestamps: true }
);

ConversationSchema.index({ deviceId: 1, updatedAt: -1 });
ConversationSchema.index({ deviceId: 1, conversationId: 1 });

export const Conversation =
  mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);

