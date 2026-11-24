import { BrandMark } from './BrandMark';

export function LoadingIndicator() {
  return (
    <div className="loading-row" role="status" aria-live="polite" aria-label="AskMed is responding">
      <div className="assistant-avatar" aria-hidden="true">
        <BrandMark size={13} />
      </div>
      <div className="loading-dots">
        <span className="loading-dot" />
        <span className="loading-dot" />
        <span className="loading-dot" />
        <span className="loading-label">Thinking…</span>
      </div>
    </div>
  );
}

