import { ArrowRight } from 'lucide-react';
import type { DocumentRecord } from '../types/chat';

interface EmptyStateProps {
  documents: DocumentRecord[];
  onSelectPrompt: (prompt: string) => void;
  disabled?: boolean;
}

const SUGGESTED_PROMPTS = [
  'Summarize the main recommendations from these documents in five bullet points.',
  'What are the key health risks or warnings highlighted here?',
  'Explain the most important findings in plain, easy-to-understand language.',
];

export function EmptyState({ documents, onSelectPrompt, disabled }: EmptyStateProps) {
  const docCount = documents.length;
  return (
    <section className="empty-state" aria-label="Ready to chat with your documents">
      <div className="empty-eyebrow">
        {docCount === 1 ? '1 document indexed' : `${docCount} documents indexed`}
      </div>
      <h1 className="empty-heading">Your documents are ready.</h1>
      <p className="empty-subtitle">
        Ask any healthcare question about the uploaded {docCount === 1 ? 'file' : 'files'}. Every answer stays grounded in your documents with exact page citations.
      </p>

      <div className="prompts-label">Suggested questions</div>
      <div className="prompt-list" role="list">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="prompt-row"
            disabled={disabled}
            onClick={() => onSelectPrompt(prompt)}
          >
            <span>{prompt}</span>
            <ArrowRight size={15} strokeWidth={1.7} className="prompt-arrow" />
          </button>
        ))}
      </div>
    </section>
  );
}
