// services/ingestService.js
// PDF -> per-page text -> cleaned -> page-aware overlapping chunks -> Pinecone upsert.
import { PDFParse } from 'pdf-parse';
import { getNamespace, getIndexMode } from '../config/clients.js';

const CHUNK_SIZE = 1000; // characters (~200-250 tokens) - fits reranker/embedder limits
const CHUNK_OVERLAP = 200; // characters of sentence-aligned overlap between chunks
const MIN_PAGE_CHARS = 40; // skip near-empty pages (covers, scanned images, etc.)
const UPSERT_BATCH = 90; // integrated-embedding upserts allow max 96 records per request

/* ------------------------------------------------------------------ */
/* 1. Extraction                                                      */
/* ------------------------------------------------------------------ */

/** Extract text page-by-page so every chunk keeps an exact page number. */
export async function extractPages(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return {
      totalPages: result.total,
      pages: result.pages.map((p) => ({ page: p.num, text: cleanText(p.text) })),
    };
  } finally {
    await parser.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* 2. Preprocessing                                                   */
/* ------------------------------------------------------------------ */

export function cleanText(raw = '') {
  return raw
    .replace(/\r/g, '\n')
    .replace(/-- \d+ of \d+ --/g, ' ') // pdf-parse page separators
    .replace(/(\w)-\n(\w)/g, '$1$2') // de-hyphenate words broken across lines
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ') // control chars
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n') // keep paragraph breaks
    .replace(/(?<!\n)\n(?!\n)/g, ' ') // join soft line wraps
    .replace(/ {2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 3. Page-aware, sentence-aligned overlapping chunking                */
/* ------------------------------------------------------------------ */

function splitSentences(text) {
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])|\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Hard-split pathological "sentences" (tables, lists without punctuation).
  return parts.flatMap((s) => {
    if (s.length <= CHUNK_SIZE) return [s];
    const out = [];
    for (let i = 0; i < s.length; i += CHUNK_SIZE - CHUNK_OVERLAP) out.push(s.slice(i, i + CHUNK_SIZE));
    return out;
  });
}

/** Chunk a single page. Chunks never cross page boundaries -> citations stay exact. */
export function chunkPage(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = [];
  let len = 0;

  for (const s of sentences) {
    if (len + s.length + 1 > size && current.length) {
      chunks.push(current.join(' '));
      // Carry trailing sentences forward as overlap.
      const carry = [];
      let carryLen = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        if (carryLen + current[i].length > overlap) break;
        carry.unshift(current[i]);
        carryLen += current[i].length + 1;
      }
      current = carry;
      len = carryLen;
    }
    current.push(s);
    len += s.length + 1;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

export function slugify(str) {
  return (
    str
      .toLowerCase()
      .replace(/\.pdf$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  );
}

/** Build Pinecone records (flat metadata, `chunk_text` is embedded by Pinecone). */
export function buildRecords(pages, meta) {
  const { docId, filename, title, publisher, sourceUrl, namespace } = meta;
  const uploadedAt = new Date().toISOString();
  const records = [];

  for (const { page, text } of pages) {
    if (text.length < MIN_PAGE_CHARS) continue;
    chunkPage(text).forEach((chunk, i) => {
      records.push({
        id: `${docId}#p${page}#c${i}`,
        chunk_text: chunk,
        doc_id: docId,
        source: filename,
        title,
        publisher,
        source_url: sourceUrl,
        page,
        chunk_index: i,
        namespace,
        uploaded_at: uploadedAt,
      });
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* 4. Full ingestion pipeline                                         */
/* ------------------------------------------------------------------ */

export async function ingestPdf({ buffer, filename, namespace, title, publisher, sourceUrl }) {
  const t0 = Date.now();
  const { totalPages, pages } = await extractPages(buffer);

  const docId = `${namespace}-${slugify(filename)}`;
  const meta = {
    docId,
    filename,
    namespace,
    title: (title || filename.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ')).trim(),
    publisher: publisher || (namespace === 'personal' ? 'User upload' : 'Unspecified'),
    sourceUrl: sourceUrl || '',
  };

  const records = buildRecords(pages, meta);
  if (!records.length) {
    const err = new Error(
      'No extractable text found in this PDF (it may be scanned/image-only). OCR is not supported in this demo.'
    );
    err.status = 422;
    throw err;
  }

  const ns = await getNamespace(namespace);
  const mode = getIndexMode();
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    if (mode === 'documents') {
      // Schema-based index: documents API (`_id` + fields; undeclared fields are stored as metadata)
      await ns.documents.upsert({ documents: batch.map(({ id, ...rest }) => ({ _id: id, ...rest })) });
    } else {
      await ns.upsertRecords({ records: batch });
    }
  }

  const pagesWithText = new Set(records.map((r) => r.page)).size;
  return {
    docId,
    namespace,
    title: meta.title,
    publisher: meta.publisher,
    filename,
    totalPages,
    pagesIndexed: pagesWithText,
    chunksUpserted: records.length,
    avgChunkChars: Math.round(records.reduce((a, r) => a + r.chunk_text.length, 0) / records.length),
    chunking: { strategy: 'page-aware, sentence-aligned', chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP },
    indexMode: mode,
    tookMs: Date.now() - t0,
    note: 'Pinecone is eventually consistent - new chunks may take a few seconds to become searchable.',
  };
}

