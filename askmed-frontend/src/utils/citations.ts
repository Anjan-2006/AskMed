import type { DocumentRecord } from '../types/chat';

// Formats inline document citations like [WHO-FAO Healthy Diets Report, p. 13]
// into clean, deduplicated Markdown tokens rendered as subtle editorial chips.

const CITE_RE = /\[([^\[\]]+?),\s*(p(?:ages?|p\.?|\.)\s*[0-9]+(?:\s*[-–,]\s*[0-9]+)*)\]/gi;
const CITE_GROUP_RE =
  /([ \t\u202f\u00a0]*)((?:\[[^\[\]]+?,\s*p(?:ages?|p\.?|\.)\s*[0-9]+(?:\s*[-–,]\s*[0-9]+)*\][ \t\u202f\u00a0]*)+)([.,;:!?]?)/gi;

export const CITE_HREF_PREFIX = '#askmed-cite:';

export interface ParsedCitation {
  title: string;
  pageLabel: string;
}

export function parseCitationHref(href?: string): ParsedCitation | null {
  if (!href || !href.startsWith(CITE_HREF_PREFIX)) return null;
  try {
    const raw = decodeURIComponent(href.slice(CITE_HREF_PREFIX.length));
    const sep = raw.lastIndexOf('||');
    if (sep === -1) return null;
    return { title: raw.slice(0, sep), pageLabel: raw.slice(sep + 2) };
  } catch {
    return null;
  }
}

function normalizePageLabel(raw: string): string {
  return raw
    .replace(/^pages?\s*/i, 'p. ')
    .replace(/^pp\.?\s*/i, 'pp. ')
    .replace(/^p\.\s*/i, 'p. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function transformPlainSegment(segment: string): string {
  return segment.replace(CITE_GROUP_RE, (_full, _leadingSpace, group: string, trailingPunct: string) => {
    const seen = new Set<string>();
    const chips: string[] = [];

    for (const match of group.matchAll(CITE_RE)) {
      const title = match[1].trim();
      const pageLabel = normalizePageLabel(match[2]);
      const key = `${title.toLowerCase()}|${pageLabel.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const href = `${CITE_HREF_PREFIX}${encodeURIComponent(`${title}||${pageLabel}`)}`;
      chips.push(`[${title} · ${pageLabel}](${href})`);
    }

    if (!chips.length) return _full;
    // Place sentence-ending punctuation cleanly before the citation chips
    return `${trailingPunct} ${chips.join(' ')}`;
  });
}

export function extractFirstPageNumber(pageLabel: string): number | undefined {
  const match = pageLabel.match(/(\d+)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const normTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Match a citation title to the exact uploaded document in a (possibly multi-PDF) conversation.
 * Priority: exact normalized title/filename -> substring containment -> token overlap (>= 50%).
 */
export function matchDocumentForCitation(
  citationTitle: string,
  documents: DocumentRecord[] = []
): DocumentRecord | null {
  if (!citationTitle || !documents.length) return null;
  const target = normTitle(citationTitle);
  if (!target) return null;

  // 1. Exact normalized match on title or filename
  for (const doc of documents) {
    if (normTitle(doc.title) === target || normTitle(doc.filename) === target) {
      return doc;
    }
  }

  // 2. Containment match (prefer longest matching document title)
  let bestContain: { doc: DocumentRecord; score: number } | null = null;
  for (const doc of documents) {
    const candidates = [normTitle(doc.title), normTitle(doc.filename)].filter(Boolean);
    for (const c of candidates) {
      if (target.includes(c) || c.includes(target)) {
        const score = Math.min(c.length, target.length);
        if (!bestContain || score > bestContain.score) {
          bestContain = { doc, score };
        }
      }
    }
  }
  if (bestContain) return bestContain.doc;

  // 3. Token overlap fallback (>= 50% shared tokens)
  const targetTokens = new Set(target.split(' ').filter((t) => t.length > 1));
  let bestOverlap: { doc: DocumentRecord; ratio: number } | null = null;
  for (const doc of documents) {
    const docTokens = new Set(
      `${normTitle(doc.title)} ${normTitle(doc.filename)}`.split(' ').filter((t) => t.length > 1)
    );
    let shared = 0;
    for (const t of targetTokens) {
      if (docTokens.has(t)) shared += 1;
    }
    const denom = Math.max(Math.min(targetTokens.size, docTokens.size), 1);
    const ratio = shared / denom;
    if (ratio >= 0.5 && (!bestOverlap || ratio > bestOverlap.ratio)) {
      bestOverlap = { doc, ratio };
    }
  }
  return bestOverlap?.doc ?? null;
}

/**
 * Transform document citations outside fenced code blocks and inline code spans
 * so code examples are never altered.
 */
export function formatCitationsForMarkdown(markdown: string): string {
  if (!markdown || !markdown.includes('[')) return markdown;
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, idx) => (idx % 2 === 1 ? part : transformPlainSegment(part)))
    .join('');
}

