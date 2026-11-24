import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

// Served directly from /public so Vite dev, preview, and production builds all load it cleanly.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

const docCache = new Map<string, Promise<PDFDocumentProxy>>();
// Strictly serialize all operations per canvas (including async loadPdfDocument / getPage)
// so React 19 StrictMode double-mounts can never overlap two render() calls on one canvas.
const canvasTail = new WeakMap<HTMLCanvasElement, Promise<void>>();
const activeRenderTasks = new WeakMap<HTMLCanvasElement, RenderTask>();

/**
 * Fetch the full PDF once and cache the parsed PDFDocumentProxy by URL.
 */
export function loadPdfDocument(url: string): Promise<PDFDocumentProxy> {
  const existing = docCache.get(url);
  if (existing) return existing;

  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to load PDF (HTTP ${res.status})`);
      }
      const buffer = await res.arrayBuffer();
      const task = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
      return task.promise;
    })
    .catch((err) => {
      docCache.delete(url);
      throw err;
    });

  docCache.set(url, promise);
  return promise;
}

/**
 * Render a single PDF page sharply onto a canvas at target CSS width (HiDPI-aware).
 * Serialized per-canvas + AbortSignal-aware so StrictMode / rapid page flips never collide.
 */
export function renderPdfPageToCanvas(params: {
  url: string;
  pageNumber: number;
  canvas: HTMLCanvasElement;
  targetWidth: number;
  scaleMultiplier?: number;
  signal?: AbortSignal;
}): Promise<{ numPages: number; clampedPage: number }> {
  const { url, canvas, targetWidth, scaleMultiplier = 1, signal } = params;

  // Cancel any currently running PDF.js render task on this canvas immediately
  const running = activeRenderTasks.get(canvas);
  if (running) {
    try {
      running.cancel();
    } catch {
      // Ignore
    }
  }

  const prev = canvasTail.get(canvas) ?? Promise.resolve();

  const run = prev
    .catch(() => {})
    .then(async () => {
      if (signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'RenderingCancelledException' });
      }

      const pdf = await loadPdfDocument(url);
      if (signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'RenderingCancelledException' });
      }

      const clampedPage = Math.min(Math.max(Math.floor(params.pageNumber || 1), 1), pdf.numPages);
      const page = await pdf.getPage(clampedPage);
      if (signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'RenderingCancelledException' });
      }

      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = (targetWidth / baseViewport.width) * scaleMultiplier;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const renderViewport = page.getViewport({ scale: cssScale * dpr });

      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.width = `${Math.floor(renderViewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(renderViewport.height / dpr)}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      const renderTask = page.render({
        canvasContext: ctx,
        viewport: renderViewport,
        canvas,
      });
      activeRenderTasks.set(canvas, renderTask);

      const onAbort = () => {
        try {
          renderTask.cancel();
        } catch {
          // Ignore
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        await renderTask.promise;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (activeRenderTasks.get(canvas) === renderTask) {
          activeRenderTasks.delete(canvas);
        }
      }

      return { numPages: pdf.numPages, clampedPage };
    });

  canvasTail.set(
    canvas,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}
