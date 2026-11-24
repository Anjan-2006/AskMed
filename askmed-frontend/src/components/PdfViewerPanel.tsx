import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { getDocumentFileUrl } from '../api/askmedApi';
import { renderPdfPageToCanvas } from '../utils/pdfLoader';

export interface ActivePdfTarget {
  conversationId: string;
  docId: string;
  title: string;
  filename: string;
  page: number;
}

interface PdfViewerPanelProps {
  target: ActivePdfTarget;
  onPageChange: (page: number) => void;
  onClose: () => void;
}

export function PdfViewerPanel({ target, onPageChange, onClose }: PdfViewerPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [numPages, setNumPages] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const pdfUrl = getDocumentFileUrl(target.conversationId, target.docId);
  const externalUrl = getDocumentFileUrl(target.conversationId, target.docId, target.page);

  useEffect(() => {
    setNumPages(0);
  }, [pdfUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const containerWidth = bodyRef.current ? Math.max(bodyRef.current.clientWidth - 36, 280) : 420;

    renderPdfPageToCanvas({
      url: pdfUrl,
      pageNumber: target.page,
      canvas,
      targetWidth: containerWidth,
      scaleMultiplier: zoom,
      signal: controller.signal,
    })
      .then(({ numPages: total, clampedPage }) => {
        if (controller.signal.aborted) return;
        setNumPages(total);
        if (clampedPage !== target.page) onPageChange(clampedPage);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === 'RenderingCancelledException') return;
        console.error('[pdf-viewer] render failed:', err);
        setError('Unable to render this PDF page. Try opening it in a new tab.');
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [pdfUrl, target.page, zoom, onPageChange]);

  return (
    <aside className="pdf-panel" aria-label="Document preview">
      <div className="pdf-panel-header">
        <div className="pdf-panel-title-wrap">
          <FileText size={15} strokeWidth={1.8} className="pdf-panel-icon" />
          <div className="pdf-panel-titles">
            <span className="pdf-panel-title" title={target.filename}>
              {target.title || target.filename}
            </span>
            <span className="pdf-panel-sub">
              {numPages > 0 ? `Page ${target.page} of ${numPages}` : `Page ${target.page}`}
            </span>
          </div>
        </div>

        <div className="pdf-panel-header-actions">
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="icon-btn"
            title="Open PDF in new tab"
            aria-label="Open PDF in new tab"
          >
            <ExternalLink size={15} strokeWidth={1.8} />
          </a>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close preview (Esc)"
            aria-label="Close PDF preview"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="pdf-panel-toolbar">
        <div className="pdf-nav-group">
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={target.page <= 1}
            onClick={() => onPageChange(Math.max(1, target.page - 1))}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="pdf-page-indicator">
            {target.page}
            {numPages > 0 ? ` / ${numPages}` : ''}
          </span>
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={numPages > 0 && target.page >= numPages}
            onClick={() => onPageChange(numPages ? Math.min(numPages, target.page + 1) : target.page + 1)}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        <div className="pdf-nav-group">
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={zoom <= 0.7}
            onClick={() => setZoom((z) => Math.max(0.7, Number((z - 0.15).toFixed(2))))}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={14} />
          </button>
          <span className="pdf-zoom-indicator">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={zoom >= 1.75}
            onClick={() => setZoom((z) => Math.min(1.75, Number((z + 0.15).toFixed(2))))}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="pdf-panel-body" ref={bodyRef}>
        {error ? (
          <div className="pdf-panel-error">
            <p>{error}</p>
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="consent-btn secondary"
            >
              Open in new tab
            </a>
          </div>
        ) : (
          <div className="pdf-canvas-stage">
            {loading && (
              <div className="pdf-loading-overlay">
                <Loader2 size={18} className="spinner" />
                <span>Rendering page {target.page}…</span>
              </div>
            )}
            <canvas ref={canvasRef} className="pdf-canvas" />
          </div>
        )}
      </div>
    </aside>
  );
}
