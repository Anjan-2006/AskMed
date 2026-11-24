import { useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import type { ChatMessage, DocumentRecord } from '../types/chat';
import { BrandMark } from './BrandMark';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageItemProps {
  message: ChatMessage;
  conversationId?: string;
  documents?: DocumentRecord[];
  isSending: boolean;
  isSpeaking: boolean;
  speechSupported: boolean;
  onRetry: (messageId: string) => void;
  onToggleSpeak: (messageId: string, content: string) => void;
  onTriggerWebSearch: (messageId: string) => void;
  onDismissWebOffer: (messageId: string) => void;
  onOpenPdf?: (doc: DocumentRecord, page: number) => void;
}

export function MessageItem({
  message,
  conversationId,
  documents,
  isSending,
  isSpeaking,
  speechSupported,
  onRetry,
  onToggleSpeak,
  onTriggerWebSearch,
  onDismissWebOffer,
  onOpenPdf,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures.
    }
  };

  if (message.role === 'user') {
    return (
      <article className="message-turn" aria-label="Your message">
        <div className="message-user-wrap">
          <div className="message-user">{message.content}</div>
        </div>
        {message.error && (
          <div className="message-error" role="alert" style={{ marginTop: 12 }}>
            <span>{message.error}</span>
            <button
              type="button"
              className="retry-btn"
              disabled={isSending}
              onClick={() => onRetry(message.id)}
            >
              <RotateCcw size={13} strokeWidth={1.8} />
              <span>Retry</span>
            </button>
          </div>
        )}
      </article>
    );
  }

  const showWebOffer =
    Boolean(message.canSearchWeb) &&
    !message.webOfferDismissed &&
    Boolean(message.webSearchQuestion);

  return (
    <article className="message-turn" aria-label="AskMed response">
      <div className="message-assistant">
        <div className="assistant-avatar" aria-hidden="true">
          <BrandMark size={13} />
        </div>
        <div className="assistant-body">
          {message.sourceType === 'web' && (
            <div className="web-source-tag">
              <Globe size={12} strokeWidth={1.8} />
              <span>From web search</span>
            </div>
          )}

          <MarkdownRenderer
            content={message.content}
            conversationId={conversationId}
            documents={documents}
            onOpenPdf={onOpenPdf}
          />

          {showWebOffer && (
            <div className="web-consent-wrap">
              <div className="web-consent-actions">
                <button
                  type="button"
                  className="consent-btn primary"
                  disabled={isSending || message.webSearchLoading}
                  onClick={() => onTriggerWebSearch(message.id)}
                >
                  {message.webSearchLoading ? (
                    <>
                      <Loader2 size={13} className="spinner" />
                      <span>Searching the web…</span>
                    </>
                  ) : (
                    <>
                      <Globe size={13} strokeWidth={1.8} />
                      <span>Search the web</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="consent-btn secondary"
                  disabled={message.webSearchLoading}
                  onClick={() => onDismissWebOffer(message.id)}
                >
                  Keep it document-only
                </button>
              </div>
              {message.webSearchError && (
                <p className="web-consent-error" role="alert">
                  {message.webSearchError}
                </p>
              )}
            </div>
          )}

          {message.sourceType === 'web' && message.webSources && message.webSources.length > 0 && (
            <div className="web-sources-block" aria-label="Web sources">
              <div className="web-sources-label">Sources</div>
              <ul className="web-sources-list">
                {message.webSources.map((src) => (
                  <li key={src.url} className="web-source-item">
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="web-source-link"
                    >
                      <span className="web-source-title">{src.title}</span>
                      <span className="web-source-domain">
                        {src.domain}
                        <ExternalLink size={11} strokeWidth={1.8} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={`assistant-actions ${copied || isSpeaking ? 'pinned' : ''}`}>
            <button
              type="button"
              className={`action-chip ${copied ? 'copied' : ''}`}
              onClick={handleCopy}
              aria-label="Copy response"
            >
              {copied ? <Check size={13} strokeWidth={1.9} /> : <Copy size={13} strokeWidth={1.7} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>

            {speechSupported && (
              <button
                type="button"
                className={`action-chip ${isSpeaking ? 'speaking' : ''}`}
                onClick={() => onToggleSpeak(message.id, message.content)}
                aria-label={isSpeaking ? 'Stop reading aloud' : 'Read response aloud'}
                title={isSpeaking ? 'Stop reading aloud' : 'Read aloud'}
              >
                {isSpeaking ? (
                  <>
                    <Square size={11} strokeWidth={2} fill="currentColor" />
                    <span>Stop</span>
                  </>
                ) : (
                  <>
                    <Volume2 size={13} strokeWidth={1.7} />
                    <span>Listen</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
