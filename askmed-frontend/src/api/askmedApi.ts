import type {
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  DocumentRecord,
  HealthApiResponse,
  TranscribeApiResponse,
} from '../types/chat';
import { getDeviceId } from '../utils/deviceId';

const DEFAULT_PROD_API_BASE = 'https://askmed-api.onrender.com';
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? DEFAULT_PROD_API_BASE : '')
).replace(/\/+$/, '');

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-device-id', getDeviceId());

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('Unable to reach the AskMed server. Make sure the backend is running.', 0);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof data?.error === 'string' && data.error.trim()
        ? data.error
        : `Request failed with status ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export async function createConversationApi(): Promise<ConversationDetail> {
  return requestJson<ConversationDetail>('/api/conversations', { method: 'POST' });
}

export async function listConversationsApi(): Promise<ConversationSummary[]> {
  const data = await requestJson<{ conversations: ConversationSummary[] }>('/api/conversations');
  return data.conversations || [];
}

export async function getConversationApi(conversationId: string): Promise<ConversationDetail> {
  return requestJson<ConversationDetail>(
    `/api/conversations/${encodeURIComponent(conversationId)}`
  );
}

export async function uploadDocumentApi(
  conversationId: string,
  file: File
): Promise<{ document: DocumentRecord; conversation: ConversationSummary }> {
  const form = new FormData();
  form.append('file', file, file.name);
  return requestJson<{ document: DocumentRecord; conversation: ConversationSummary }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/documents`,
    { method: 'POST', body: form }
  );
}

export function getDocumentFileUrl(
  conversationId: string,
  docId: string,
  page?: number
): string {
  const base = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(docId)}/file?deviceId=${encodeURIComponent(getDeviceId())}`;
  return page && Number.isInteger(page) && page > 0 ? `${base}#page=${page}` : base;
}

export async function removeDocumentApi(
  conversationId: string,
  docId: string
): Promise<{ removed: boolean; docId: string }> {
  return requestJson<{ removed: boolean; docId: string }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE' }
  );
}

export async function startConversationApi(conversationId: string): Promise<ConversationDetail> {
  return requestJson<ConversationDetail>(
    `/api/conversations/${encodeURIComponent(conversationId)}/start`,
    { method: 'POST' }
  );
}

export async function sendConversationMessageApi(
  conversationId: string,
  question: string
): Promise<{
  conversationId: string;
  title: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}> {
  return requestJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }
  );
}

export async function runConversationWebSearchApi(
  conversationId: string,
  question: string,
  messageId: string
): Promise<{ conversationId: string; assistantMessage: ChatMessage }> {
  return requestJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/web-search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, messageId }),
    }
  );
}

export async function dismissConversationWebOfferApi(
  conversationId: string,
  messageId: string
): Promise<void> {
  await requestJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/dismiss-web`,
    { method: 'PATCH' }
  );
}

export async function deleteConversationApi(conversationId: string): Promise<void> {
  await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

export async function transcribeVoice(
  audioBlob: Blob,
  filename = 'recording.webm'
): Promise<TranscribeApiResponse> {
  const form = new FormData();
  form.append('audio', audioBlob, filename);
  return requestJson<TranscribeApiResponse>('/api/chat/transcribe', {
    method: 'POST',
    body: form,
  });
}

export async function checkBackendHealth(): Promise<HealthApiResponse> {
  return requestJson<HealthApiResponse>('/api/health');
}
