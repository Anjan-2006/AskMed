import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { getDocumentFileUrl } from '../api/askmedApi';
import type { DocumentRecord } from '../types/chat';
import { renderPdfPageToCanvas } from '../utils/pdfLoader';

interface CitationChipProps {
  title: string;
  pageLabel: string;
  pageNum: number;
  conversationId: string;
  doc: DocumentRecord;
  onOpenPdf: (doc: DocumentRecord, page: number) => void;
}

export function CitationChip({
  title,
  pageLabel,
  pageNum,
  conversationId,
  doc,
  onOpenPdf,
}: CitationChipProps) {
  const [hovered, setHovered] = useState(false);
  const [popoverCoords, setPopoverCoords] = useState<{
    top: number;
    left: number;
    placeAbove: boolean;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState(false);

  const chipRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const pdfUrl = getDocumentFileUrl(conversationId, doc.docId);

  const clearTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleMouseEnter = () => {
    clearTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (!rect) return;
      const popoverW = 264;
      const popoverH = 340;
      const placeAbove = rect.top > popoverH + 16;
      const left = Math.min(
        Math.max(12, rect.left + rect.width / 2 - popoverW / 2),
        window.innerWidth - popoverW - 12
      );
      const top = placeAbove ? rect.top - 10 : rect.bottom + 10;
      setPopoverCoords({ top, left, placeAbove });
      setHovered(true);
    }, 220);
  };

  const handleMouseLeave = () => {
    clearTimer();
    setHovered(false);
  };

  useEffect(() => {
    return () => clearTimer();
  }, []);

  // Dismiss hover popover immediately when the user scrolls or resizes the viewport
  useEffect(() => {
    if (!hovered) return;
    const dismiss = () => {
      clearTimer();
      setHovered(false);
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [hovered]);

  useEffect(() => {
    if (!hovered) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    setPreviewLoading(true);
    setPreviewError(false);

    renderPdfPageToCanvas({
      url: pdfUrl,
      pageNumber: pageNum,
      canvas,
      targetWidth: 244,
      signal: controller.signal,
    })
      .then(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === 'RenderingCancelledException') return;
        setPreviewError(true);
        setPreviewLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [hovered, pdfUrl, pageNum]);

  const popover =
    hovered && popoverCoords && typeof document !== 'undefined'
      ? createPortal(
          <div
            className={`pdf-hover-popover ${popoverCoords.placeAbove ? 'above' : 'below'}`}
            style={{
              top: popoverCoords.top,
              left: popoverCoords.left,
            }}
            role="tooltip"
          >
            <div className="pdf-hover-header">
              <span className="pdf-hover-title">{doc.title || doc.filename}</span>
              <span className="pdf-hover-page">{pageLabel}</span>
            </div>
            <div className="pdf-hover-stage">
              {previewLoading && (
                <div className="pdf-hover-loading">
                  <Loader2 size={14} className="spinner" />
                </div>
              )}
              {previewError ? (
                <span className="pdf-hover-fallback">Click to view PDF</span>
              ) : (
                <canvas ref={canvasRef} className="pdf-hover-canvas" />
              )}
            </div>
            <div className="pdf-hover-footer">Click to open side-by-side</div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="cite-chip clickable"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={() => {
          clearTimer();
          setHovered(false);
          onOpenPdf(doc, pageNum);
        }}
        title={`Click to inspect ${doc.filename} (${pageLabel})`}
      >
        <span className="cite-title">{title}</span>
        <span className="cite-sep" aria-hidden="true">
          ·
        </span>
        <span className="cite-page">{pageLabel}</span>
      </button>
      {popover}
    </>
  );
}
