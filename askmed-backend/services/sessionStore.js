// services/sessionStore.js
// In-memory, session-scoped conversation memory for the interactive chat API/CLI.
// Each sessionId has its own isolated history; sessions expire after inactivity.
// (Single-process demo store: swap for Redis or a database to run multiple instances.)
import { randomUUID } from 'node:crypto';

const MAX_MESSAGES = 12; // last 6 user/assistant exchanges kept per session
const MAX_CONTENT_CHARS = 2000; // cap each stored message so prompts stay bounded
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity
const MAX_SESSIONS = 1000;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const sessions = new Map(); // sessionId -> { messages: [{ role, content }], updatedAt }

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export function createSessionId() {
  return randomUUID();
}

function prune(now = Date.now()) {
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  // Map preserves insertion order and touched sessions are re-inserted, so the first entries are the least recently used
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

/** Return a copy of the session's history (oldest first). Unknown or expired sessions return []. */
export function getHistory(sessionId) {
  if (!sessionId) return [];
  const s = sessions.get(sessionId);
  if (!s) return [];
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return [];
  }
  return s.messages.map((m) => ({ ...m }));
}

/** Append one completed user/assistant exchange to the session. */
export function appendTurn(sessionId, userContent, assistantContent) {
  if (!sessionId) return;
  const now = Date.now();
  const s = sessions.get(sessionId) || { messages: [], updatedAt: now };
  s.messages.push(
    { role: 'user', content: String(userContent).slice(0, MAX_CONTENT_CHARS) },
    { role: 'assistant', content: String(assistantContent).slice(0, MAX_CONTENT_CHARS) }
  );
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
  s.updatedAt = now;
  sessions.delete(sessionId); // re-insert to mark as most recently used
  sessions.set(sessionId, s);
  prune(now);
}

export function clearSession(sessionId) {
  return sessions.delete(sessionId);
}

/** Test helper. */
export function _resetAllSessions() {
  sessions.clear();
}

