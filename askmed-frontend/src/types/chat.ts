export type MessageRole = 'user' | 'assistant';

export interface WebSource {
  title: string;
  url: string;
  domain: string;
}

export interface CitationItem {
  citation: string;
  title: string;
  page: number;
  namespace?: string;
  publisher?: string;
  sourceUrl?: string;
}

export interface DocumentRecord {
  docId: string;
  filename: string;
  title: string;
  sizeBytes: number;
  totalPages: number;
  status: 'processing' | 'ready' | 'error';
  hasFile?: boolean;
  uploadedAt?: string;
}

export interface DraftUploadItem {
  localId: string;
  filename: string;
  sizeBytes: number;
  status: 'uploading' | 'ready' | 'error';
  docId?: string;
  title?: string;
  totalPages?: number;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  error?: string;
  sourceType?: 'documents' | 'web' | 'chat' | 'guard';
  citations?: CitationItem[];
  canSearchWeb?: boolean;
  webOfferDismissed?: boolean;
  webSearchQuestion?: string;
  webSearchLoading?: boolean;
  webSearchError?: string;
  webSources?: WebSource[];
  refused?: boolean;
  grounded?: boolean;
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  status: 'setup' | 'active';
  documents: DocumentRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
}

export interface TranscribeApiResponse {
  text: string;
  tookMs?: number;
}

export interface HealthApiResponse {
  status: 'ok' | 'degraded';
  groq?: { ok: boolean; model?: string; error?: string };
  pinecone?: { ok: boolean; index?: string; ready?: boolean; error?: string };
  mongodb?: { ok: boolean; configured?: boolean; error?: string };
}
