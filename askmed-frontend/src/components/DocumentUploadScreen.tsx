import { useRef, useState, type DragEvent } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  History,
  Loader2,
  Upload,
  X,
  AlertCircle,
} from 'lucide-react';
import type { DraftUploadItem } from '../types/chat';
import { BrandMark } from './BrandMark';

interface DocumentUploadScreenProps {
  uploads: DraftUploadItem[];
  starting: boolean;
  setupError: string | null;
  historyCount: number;
  sidebarCollapsed: boolean;
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (localId: string) => void;
  onStartConversation: () => void;
  onOpenHistory: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentUploadScreen({
  uploads,
  starting,
  setupError,
  historyCount,
  sidebarCollapsed,
  onAddFiles,
  onRemoveFile,
  onStartConversation,
  onOpenHistory,
}: DocumentUploadScreenProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const readyCount = uploads.filter((u) => u.status === 'ready').length;
  const uploadingCount = uploads.filter((u) => u.status === 'uploading').length;
  const canStart = readyCount > 0 && uploadingCount === 0 && !starting;

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) {
      onAddFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="upload-workspace">
      <header className="upload-header">
        <div className="upload-brand">
          <span className="brand-mark">
            <BrandMark size={14} />
          </span>
          <div className="upload-brand-text">
            <span className="brand-wordmark">AskMed</span>
            <span className="upload-tagline">Healthcare document intelligence</span>
          </div>
        </div>

        {sidebarCollapsed && (
          <button
            type="button"
            className="history-trigger-btn"
            onClick={onOpenHistory}
          >
            <History size={15} strokeWidth={1.75} />
            <span>Previous conversations</span>
            {historyCount > 0 && <span className="history-count">{historyCount}</span>}
          </button>
        )}
      </header>

      <div className="upload-scroll">
        <div className="upload-column">
          <div className="upload-intro">
            <p className="empty-eyebrow">New healthcare session</p>
            <h1 className="upload-heading">Start with your healthcare documents.</h1>
            <p className="upload-subtitle">
              Upload one or more PDF documents—clinical guidelines, lab reports, research papers, or nutrition briefs. AskMed grounds every answer in your uploaded files with page-level citations.
            </p>
          </div>

          {setupError && (
            <div className="setup-error-banner" role="alert">
              <AlertCircle size={15} strokeWidth={1.8} />
              <span>{setupError}</span>
            </div>
          )}

          <div
            className={`dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload healthcare PDF documents"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) {
                  onAddFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <div className="dropzone-icon">
              <Upload size={20} strokeWidth={1.7} />
            </div>
            <p className="dropzone-title">
              {dragging ? 'Drop PDF files to upload' : 'Drag and drop PDF documents here'}
            </p>
            <p className="dropzone-meta">
              Supports multiple healthcare PDFs up to 25 MB each. Isolated to this conversation.
            </p>
            <span className="dropzone-btn">Choose PDF files</span>
          </div>

          {uploads.length > 0 && (
            <section className="doc-queue" aria-label="Selected documents">
              <div className="doc-queue-header">
                <span className="prompts-label" style={{ marginBottom: 0 }}>
                  Uploaded documents ({readyCount}/{uploads.length} ready)
                </span>
              </div>
              <ul className="doc-queue-list">
                {uploads.map((item) => (
                  <li key={item.localId} className={`doc-card ${item.status}`}>
                    <div className="doc-card-left">
                      <span className="doc-card-icon">
                        <FileText size={16} strokeWidth={1.7} />
                      </span>
                      <div className="doc-card-info">
                        <span className="doc-card-name" title={item.filename}>
                          {item.filename}
                        </span>
                        <span className="doc-card-meta">
                          {formatBytes(item.sizeBytes)}
                          {item.totalPages ? ` · ${item.totalPages} pages` : ''}
                          {item.error ? ` · ${item.error}` : ''}
                        </span>
                      </div>
                    </div>

                    <div className="doc-card-right">
                      {item.status === 'uploading' && (
                        <span className="doc-status uploading">
                          <Loader2 size={13} className="spinner" />
                          <span>Indexing…</span>
                        </span>
                      )}
                      {item.status === 'ready' && (
                        <span className="doc-status ready">
                          <CheckCircle2 size={13} strokeWidth={2} />
                          <span>Ready</span>
                        </span>
                      )}
                      {item.status === 'error' && (
                        <span className="doc-status error">Failed</span>
                      )}
                      <button
                        type="button"
                        className="doc-remove-btn"
                        disabled={item.status === 'uploading'}
                        onClick={() => onRemoveFile(item.localId)}
                        aria-label={`Remove ${item.filename}`}
                        title="Remove document"
                      >
                        <X size={14} strokeWidth={1.8} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="upload-footer-cta">
            <button
              type="button"
              className="start-conv-btn"
              disabled={!canStart}
              onClick={onStartConversation}
            >
              {starting ? (
                <>
                  <Loader2 size={15} className="spinner" />
                  <span>Starting conversation…</span>
                </>
              ) : (
                <>
                  <span>Start conversation</span>
                  <ArrowRight size={15} strokeWidth={2} />
                </>
              )}
            </button>
            <span className="upload-cta-note">
              {readyCount === 0
                ? 'Upload at least one PDF document to begin.'
                : uploadingCount > 0
                  ? 'Waiting for documents to finish indexing…'
                  : `${readyCount} ${readyCount === 1 ? 'document' : 'documents'} ready for grounded Q&A.`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

