// services/retrieveService.js
// Multi-namespace hybrid retrieval:
//   Stage 1  Dense semantic search  - Pinecone integrated llama-text-embed-v2 (per namespace)
//   Stage 2  Lexical search         - Pinecone server-side full-text (BM25) on chunk_text + title
//                                     (falls back to local BM25 over the candidate pool on legacy indexes)
//   Stage 3  Reciprocal Rank Fusion - merge dense + lexical rankings into one hybrid ranking
//   Stage 4  Cross-encoder rerank   - bge-reranker-v2-m3 over the fused shortlist -> final score sort
import { config, getNamespace, getPinecone, getIndexMode, getFullTextFields, isValidNamespace } from '../config/clients.js';

const FIELDS = ['chunk_text', 'source', 'title', 'publisher', 'source_url', 'page', 'doc_id', 'chunk_index'];
const RRF_K = 60;

export function resolveNamespaces(scope = 'both') {
  if (scope === 'both') return ['builtin', 'personal'];
  if (isValidNamespace(scope)) return [scope];
  const err = new Error(`Invalid scope "${scope}". Use builtin | personal | both | conv_<id>`);
  err.status = 400;
  throw err;
}

/* ----------------------------- Tokenizer / BM25 -------------------------------- */
const STOPWORDS = new Set(
  ('a an and are as at be but by can do does for from has have how i if in into is it its of on or ' +
    'should so than that the their them then there these they this to was what when where which who ' +
    'why will with you your my me we our about also any been being more most not no other some such')
    .split(' ')
);

export function tokenize(text = '') {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Strip meta-document phrasing ("According to the report, ...", "What does the document mean by ...")
 * before dense search, lexical search, and cross-encoder reranking.
 * Cross-encoders like bge-reranker-v2-m3 heavily penalize passages when the query mentions
 * "the report" / "the document" (terms absent from the underlying health text).
 */
export function normalizeQueryForRetrieval(query = '') {
  let q = query.trim();
  const docNoun = '(?:this|the)\\s+(?:report|document|pdf|paper|guide|guideline|statement|text|source|file|article)';
  // Strip leading meta-clauses: "According to the report, ..." / "Based on this document, ..." / "In the PDF, ..."
  q = q.replace(new RegExp(`^(?:according\\s+to|based\\s+on|from|in)\\s+${docNoun}[,:]?\\s+`, 'i'), '');
  // Rewrite "What does the report mean by X?" -> "What is X?"
  q = q.replace(new RegExp(`^what\\s+does\\s+${docNoun}\\s+(?:mean\\s+by|define\\s+as)\\s+`, 'i'), 'What is ');
  // Rewrite "What does the report say about X?" -> "What about X?" / "X"
  q = q.replace(new RegExp(`^what\\s+does\\s+${docNoun}\\s+(?:say|state|explain|mention|recommend)\\s+(?:about|regarding|on)\\s+`, 'i'), '');
  // Strip trailing meta-clauses: "... according to the report?"
  q = q.replace(new RegExp(`[,\\s]+(?:according\\s+to|in|from|based\\s+on)\\s+${docNoun}(\\??)$`, 'i'), '$1');
  q = q.replace(/\s+/g, ' ').trim();
  return q.length >= 3 ? q : query.trim();
}

/** Local BM25 (only used for legacy indexes without server-side full-text search). */
function bm25Scores(query, docs, k1 = 1.2, b = 0.75) {
  const qTerms = [...new Set(tokenize(query))];
  const docTokens = docs.map((d) => tokenize(d));
  const N = docs.length || 1;
  const avgdl = docTokens.reduce((a, t) => a + t.length, 0) / N || 1;
  const df = Object.fromEntries(qTerms.map((q) => [q, docTokens.filter((t) => t.includes(q)).length]));
  return docTokens.map((tokens) => {
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return qTerms.reduce((score, q) => {
      if (!tf[q]) return score;
      const idf = Math.log(1 + (N - df[q] + 0.5) / (df[q] + 0.5));
      return score + (idf * tf[q] * (k1 + 1)) / (tf[q] + k1 * (1 - b + (b * tokens.length) / avgdl));
    }, 0);
  });
}

/* ----------------------------- Search primitives -------------------------------- */

const isMissingNamespace = (err) =>
  err?.name === 'PineconeNotFoundError' || /not found|namespace .* does not exist/i.test(err?.message || '');

function toCandidate(namespace, id, fields) {
  return { key: `${namespace}:${id}`, id, namespace, ...fields };
}

/** Stage 1: dense semantic search in one namespace. */
async function denseSearch(namespace, query, topK) {
  try {
    const ns = await getNamespace(namespace);
    if (getIndexMode() === 'documents') {
      const res = await ns.documents.search({
        scoreBy: [{ type: 'embed', field: config.pinecone.textField, query }],
        topK,
        includeFields: FIELDS,
      });
      return res.matches.map(({ _id, _score, ...f }) => ({ ...toCandidate(namespace, _id, f), denseScore: _score ?? 0 }));
    }
    const res = await ns.searchRecords({ query: { topK, inputs: { text: query } }, fields: FIELDS });
    return (res.result?.hits || []).map((h) => ({ ...toCandidate(namespace, h._id, h.fields), denseScore: h._score }));
  } catch (err) {
    if (isMissingNamespace(err)) return []; // empty namespace should not break a "both" query
    throw err;
  }
}

/** Stage 2: server-side full-text (BM25) search in one namespace (schema-based indexes only). */
async function lexicalSearch(namespace, query, topK) {
  const fields = getFullTextFields().filter((f) => [config.pinecone.textField, 'title'].includes(f));
  const terms = [...new Set(tokenize(query))];
  if (getIndexMode() !== 'documents' || !fields.length || !terms.length) return [];
  try {
    const ns = await getNamespace(namespace);
    const res = await ns.documents.search({
      scoreBy: [{ type: 'text', fields, query: terms.join(' ') }],
      topK,
      includeFields: FIELDS,
    });
    return res.matches.map(({ _id, _score, ...f }) => ({ ...toCandidate(namespace, _id, f), lexicalScore: _score ?? 0 }));
  } catch (err) {
    if (isMissingNamespace(err)) return [];
    console.warn(`[retrieve] full-text search failed in "${namespace}", continuing dense-only: ${err.message}`);
    return [];
  }
}

/** Assign 1-based ranks to candidates that have a score for `key` (others get null). */
function assignRanks(pool, key, rankKey) {
  pool
    .filter((c) => c[key] != null && c[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .forEach((c, i) => (c[rankKey] = i + 1));
  pool.forEach((c) => (c[rankKey] ??= null));
}

const fx = (v, d = 4) => (v == null ? null : Number(v.toFixed(d)));

/* ----------------------------- Main retrieval -------------------------------- */

/**
 * @param {string} query
 * @param {object} opts { scope, topK (final), candidateK (per namespace per method), denseWeight, lexicalWeight }
 */
export async function retrieve(query, opts = {}) {
  const { scope = 'both', topK = 5, candidateK = 20, denseWeight = 0.6, lexicalWeight = 0.4 } = opts;
  const namespaces = resolveNamespaces(scope);
  const t0 = Date.now();
  const mode = getIndexMode();
  const searchQuery = normalizeQueryForRetrieval(query);

  // Stages 1 + 2: dense and lexical search across namespaces, all in parallel
  const [denseLists, lexLists] = await Promise.all([
    Promise.all(namespaces.map((ns) => denseSearch(ns, searchQuery, candidateK))),
    Promise.all(namespaces.map((ns) => lexicalSearch(ns, searchQuery, candidateK))),
  ]);

  // Merge into one candidate pool keyed by namespace:id
  const poolMap = new Map();
  for (const c of [...denseLists.flat(), ...lexLists.flat()]) {
    poolMap.set(c.key, { ...poolMap.get(c.key), ...c });
  }
  const pool = [...poolMap.values()].filter((c) => c.chunk_text);

  const lexicalSource = mode === 'documents' && getFullTextFields().length ? 'pinecone-full-text' : 'local-bm25';
  const stats = {
    indexMode: mode,
    normalizedQuery: searchQuery !== query.trim() ? searchQuery : undefined,
    namespacesSearched: namespaces,
    denseHits: Object.fromEntries(namespaces.map((ns, i) => [ns, denseLists[i].length])),
    lexicalHits: Object.fromEntries(namespaces.map((ns, i) => [ns, lexLists[i].length])),
    lexicalSource,
  };
  if (!pool.length) return { results: [], stats: { ...stats, tookMs: Date.now() - t0 } };

  // Legacy index: compute BM25 locally over the dense candidate pool
  if (lexicalSource === 'local-bm25') {
    const lex = bm25Scores(searchQuery, pool.map((c) => c.chunk_text));
    pool.forEach((c, i) => (c.lexicalScore = lex[i]));
  }

  // Stage 3: Reciprocal Rank Fusion
  assignRanks(pool, 'denseScore', 'denseRank');
  assignRanks(pool, 'lexicalScore', 'lexicalRank');
  pool.forEach((c) => {
    c.hybridScore =
      (c.denseRank ? denseWeight / (RRF_K + c.denseRank) : 0) +
      (c.lexicalRank ? lexicalWeight / (RRF_K + c.lexicalRank) : 0);
  });
  const fused = pool.sort((a, b) => b.hybridScore - a.hybridScore).slice(0, 40);

  // Stage 4: cross-encoder rerank over the fused shortlist (single call across namespaces)
  const rr = await getPinecone().inference.rerank({
    model: config.pinecone.rerankModel,
    query: searchQuery,
    documents: fused.map((c) => ({ chunk_text: c.chunk_text })),
    rankFields: ['chunk_text'],
    topN: Math.min(topK, fused.length),
    returnDocuments: false,
    parameters: { truncate: 'END' },
  });

  const results = rr.data
    .map((d) => ({ ...fused[d.index], rerankScore: d.score }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .map((r, i) => ({
      rank: i + 1,
      id: r.id,
      namespace: r.namespace,
      title: r.title,
      source: r.source,
      publisher: r.publisher,
      sourceUrl: r.source_url,
      page: Number(r.page),
      citation: `[${r.title}, p. ${Number(r.page)}]`,
      scores: {
        rerank: fx(r.rerankScore),
        dense: fx(r.denseScore),
        lexical: fx(r.lexicalScore),
        hybridRrf: fx(r.hybridScore, 5),
        denseRank: r.denseRank,
        lexicalRank: r.lexicalRank,
      },
      text: r.chunk_text,
    }));

  return {
    results,
    stats: {
      ...stats,
      candidatePool: pool.length,
      rerankedShortlist: fused.length,
      pipeline:
        `dense(${config.pinecone.embedModel}) + lexical(${lexicalSource}) -> ` +
        `RRF(k=${RRF_K}, w=${denseWeight}/${lexicalWeight}) -> rerank(${config.pinecone.rerankModel})`,
      tookMs: Date.now() - t0,
    },
  };
}
