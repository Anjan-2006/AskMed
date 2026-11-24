import { Eye, FileText } from 'lucide-react';
import type { DocumentRecord } from '../types/chat';

interface DocumentContextBarProps {
  documents: DocumentRecord[];
  activeDocId?: string | null;
  onOpenPdf: (doc: DocumentRecord, page: number) => void;
}

export function DocumentContextBar({
  documents,
  activeDocId,
  onOpenPdf,
}: DocumentContextBarProps) {
  if (!documents.length) return null;

  return (
    <div className="doc-context-bar" aria-label="Documents in this conversation">
      <div className="doc-context-inner">
        <span className="doc-context-label">Documents</span>
        <div className="doc-context-chips">
          {documents.map((doc) => {
            const label = doc.title || doc.filename;
            const clickable = doc.hasFile !== false;
            const isSelected = activeDocId === doc.docId;
            if (clickable) {
              return (
                <button
                  key={doc.docId}
                  type="button"
                  onClick={() => onOpenPdf(doc, 1)}
                  className={`doc-context-chip clickable ${isSelected ? 'selected' : ''}`}
                  title={`Preview ${doc.filename}${doc.totalPages ? ` (${doc.totalPages} pages)` : ''}`}
                >
                  <FileText size={12} strokeWidth={1.8} />
                  <span className="doc-context-name">{label}</span>
                  {doc.totalPages > 0 && (
                    <span className="doc-context-pages">{doc.totalPages}p</span>
                  )}
                  <Eye size={11} strokeWidth={1.8} className="doc-open-icon" />
                </button>
              );
            }
            return (
              <span
                key={doc.docId}
                className="doc-context-chip"
                title={`${doc.filename}${doc.totalPages ? ` (${doc.totalPages} pages)` : ''}`}
              >
                <FileText size={12} strokeWidth={1.8} />
                <span className="doc-context-name">{label}</span>
                {doc.totalPages > 0 && (
                  <span className="doc-context-pages">{doc.totalPages}p</span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
