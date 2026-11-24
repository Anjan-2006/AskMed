import { useEffect, useRef } from 'react';
import type { ChatMessage, DocumentRecord } from '../types/chat';
import { LoadingIndicator } from './LoadingIndicator';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  conversationId: string;
  documents: DocumentRecord[];
  messages: ChatMessage[];
  isSending: boolean;
  speakingMessageId: string | null;
  speechSupported: boolean;
  onRetry: (messageId: string) => void;
  onToggleSpeak: (messageId: string, content: string) => void;
  onTriggerWebSearch: (messageId: string) => void;
  onDismissWebOffer: (messageId: string) => void;
  onOpenPdf: (doc: DocumentRecord, page: number) => void;
}

export function MessageList({
  conversationId,
  documents,
  messages,
  isSending,
  speakingMessageId,
  speechSupported,
  onRetry,
  onToggleSpeak,
  onTriggerWebSearch,
  onDismissWebOffer,
  onOpenPdf,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const hasInlineWebSearch = messages.some((m) => m.webSearchLoading);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isSending]);

  return (
    <div className="conversation-column">
      <div className="message-list">
        {messages.map((msg) => (
          <MessageItem
            key={msg.id}
            message={msg}
            conversationId={conversationId}
            documents={documents}
            isSending={isSending}
            isSpeaking={speakingMessageId === msg.id}
            speechSupported={speechSupported}
            onRetry={onRetry}
            onToggleSpeak={onToggleSpeak}
            onTriggerWebSearch={onTriggerWebSearch}
            onDismissWebOffer={onDismissWebOffer}
            onOpenPdf={onOpenPdf}
          />
        ))}
        {isSending && !hasInlineWebSearch && <LoadingIndicator />}
      </div>
      <div ref={bottomRef} style={{ height: 8 }} />
    </div>
  );
}
