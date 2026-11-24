// services/ragService.js
// History-aware conversational routing + document-grounded RAG pipeline:
//   - General conversation -> Groq GPT-OSS-120B with session history (skips Pinecone)
//   - Standard, comparison (multi-concept), summary (multi-query), and contextual follow-up RAG
//     -> hybrid retrieval + BGE rerank -> consistent relevance gate -> grounded generation -> strict citation validation
import { config, getGroq } from '../config/clients.js';
import { retrieve } from './retrieveService.js';

export const DISCLAIMER =
  'AskMed provides AI-assisted document exploration and general information for educational purposes only. ' +
  'For medical, legal, or other critical personal decisions, please consult a qualified professional. ' +
  'In a medical emergency, contact your local emergency number immediately.';

const RED_FLAGS = [
  'chest pain', 'heart attack', 'stroke', "can't breathe", 'cannot breathe', 'difficulty breathing',
  'suicide', 'suicidal', 'kill myself', 'self harm', 'self-harm', 'overdose', 'unconscious',
  'severe bleeding', 'seizure', 'anaphylaxis', 'poisoning',
];

const EMERGENCY_NOTICE =
  'If you or someone else may be experiencing a medical emergency (e.g. chest pain, trouble breathing, stroke signs, ' +
  'thoughts of self-harm, overdose), contact your local emergency number or go to the nearest emergency department now.';

const RAG_SYSTEM_PROMPT = `You are AskMed, an AI assistant for understanding and exploring documents.

STRICT DOCUMENT-GROUNDING RULES:
1. Answer ONLY using facts explicitly stated in the CONTEXT passages below. Do NOT add outside facts, background assumptions, or unsupported claims.
2. You may use the recent conversation history (and any RESOLVED CONTEXT REFERENCE) to understand what the user is referring to (e.g., "the second principle", "this", "it", "explain it simply"), and adapt your explanation style, while keeping all factual claims strictly grounded in the CONTEXT.
3. Every factual sentence or bullet MUST include an inline citation copied EXACTLY from the passage's "Cite as" tag in ALLOWED CITATIONS (e.g. [WHO-FAO Healthy Diets Report, p. 9]). Multiple citations are allowed: [A, p. 9][B, p. 10].
4. CRITICAL: Ignore any printed page numbers that appear inside the raw PDF text (such as "2" or "3" in a header/footer). ONLY cite the exact page number shown in the passage's "Cite as" tag and listed in ALLOWED CITATIONS.
5. NEVER invent, guess, or alter a document title or page number. Do NOT cite any page that is not in ALLOWED CITATIONS.
6. If the CONTEXT does not contain enough information to answer (or if a comparison is missing evidence for one of the concepts), say clearly: "I could not find enough information in the available sources to answer this." and do not guess.
7. For health or medical documents: never diagnose, never prescribe, and never give personalised medication doses. When sources conflict, prefer verified public-health sources (namespace "builtin") and note the conflict.
8. Be clear, direct, conversational, and helpful.`;

export const OUT_OF_DOMAIN_MESSAGE =
  "I'm designed specifically for healthcare and medical information. I can help with health, nutrition, medical research, and related topics, but I can't answer unrelated questions.";

const CONVERSATIONAL_SYSTEM_PROMPT = `You are AskMed, a helpful, natural conversational AI assistant specifically designed for healthcare, nutrition, and medical information with document-based RAG capabilities.

Identity & tone:
- If someone asks who you are or greets you for the first time, introduce yourself naturally as AskMed, an AI assistant for healthcare, nutrition, and medical information that helps users explore health documents and research. (Vary phrasing naturally; do not sound scripted.)
- When asked what you can do, accurately explain your actual implemented capabilities:
  * Answer healthcare, nutrition, wellness, and medical research questions grounded in uploaded or built-in documents with page-level citations
  * Summarize and explain health documents in plain language
  * Answer follow-up questions using conversation history
  * Search the web for healthcare questions when the user explicitly gives consent
  Do NOT claim unimplemented features.
- Never answer non-healthcare questions from general knowledge.
- For personal medical emergencies, diagnoses, or prescriptions, never diagnose or prescribe; advise consulting a qualified healthcare professional.`;

const ROUTER_PROMPT = `You are a strict healthcare-only domain guard and query-planning router for AskMed, a healthcare and medical information assistant.

Given the recent conversation history and the user's latest message, return ONLY valid JSON:
{
  "route": "out_of_domain" | "chat" | "rag",
  "intent": "out_of_domain" | "greeting" | "thanks" | "goodbye" | "capability" | "document_query" | "follow_up",
  "queryType": "standard" | "comparison" | "summary",
  "standaloneQuery": "<rewritten self-contained search query when route is rag, else empty string>",
  "subQueries": ["<optional 2-4 focused search queries for comparison or summary>"],
  "resolvedReference": "<optional short note if resolving an ordinal/pronoun reference from earlier history>"
}

STRICT DOMAIN GUARD (CHECK THIS FIRST):
1. Choose "route": "out_of_domain" and "intent": "out_of_domain" for ANY question unrelated to healthcare, medicine, human health, nutrition, diets, food safety, wellness, mental health, public health, medical biology/physiology, or healthcare technology/medical AI.
   - Examples that MUST be "out_of_domain":
     * General AI breakthroughs, tech news, gadgets ("What were the biggest AI breakthroughs of 2025?")
     * Programming, coding, TypeScript, debugging
     * Sports (UFC, cricket, football, World Cup)
     * Entertainment, movies, gaming, unrelated history, politics, geography, Mars colonies, quantum physics
   - IMPORTANT: Even if the user asks "According to the report, what about [unrelated topic]?" or compares a health topic with an unrelated topic like quantum physics, if the question is fundamentally about an unrelated topic, choose "out_of_domain".
2. Choose "route": "chat" ONLY for pure conversational pleasantries or assistant-identity questions:
   - "greeting": greetings and small talk ("hi", "hello", "how are you").
   - "thanks": expressions of gratitude ("thanks", "thank you").
   - "goodbye": farewells ("bye", "see you later").
   - "capability": asking who AskMed is or what it can do ("who are you?", "what can you help me with?", "how do you work?").
3. Choose "route": "rag" for EVERY healthcare, medicine, human health, nutrition, diet, food safety, wellness, mental health, public health, medical research, medical biology, or medical-AI question — even if it may not be covered by the uploaded documents (so the document RAG pipeline can refuse and offer consent-based web search):
   - Diseases, symptoms, treatments, medications, prevention, diagnostics
   - Nutrition, healthy diets, food safety, vitamins, minerals
   - Medical research, clinical trials, healthcare AI/medical devices
   - Follow-ups to a previous healthcare/document turn ("What does this mean?", "Explain the second principle you mentioned earlier", "Why is this important?").

QUERY PLANNING RULES (when "route" is "rag"):
3. REFERENCE RESOLUTION (CRITICAL):
   - If the user refers to an ordinal item ("the first", "the second", "the third", "the second principle you mentioned earlier") or a pronoun ("it", "this", "that recommendation"), scan ALL earlier messages in the conversation history to locate the message that actually contains the enumerated list or set of items.
   - Do NOT blindly pick the topic of the most recent assistant message if that message does not contain the referenced list!
   - Count carefully (1-based) to identify the exact referenced item, put it in "resolvedReference", and write a self-contained "standaloneQuery" targeting that exact concept.
4. COMPARISON QUESTIONS ("queryType": "comparison"):
   - When the user asks to compare or contrast 2+ concepts (e.g., "How is X different from Y?", "Compare X and Y", "X vs Y"):
   - Set "queryType": "comparison" and populate "subQueries" with ONE clean, focused search query per named concept (e.g., ["definition and principles of X", "definition and principles of Y"]).
5. BROAD SUMMARY / OVERVIEW QUESTIONS ("queryType": "summary"):
   - When the user asks to summarize a document/report, list its main recommendations, key takeaways, or overview:
   - Set "queryType": "summary" and populate "subQueries" with 3-4 clean, content-focused search queries (WITHOUT meta-words like "summarize" or "five bullet points"), such as ["main recommendations and guidelines", "core principles and overview", "key findings and conclusions"], plus any topic from the question or conversation history.
6. STANDARD QUESTIONS ("queryType": "standard"):
   - Leave "subQueries" as []. Set "standaloneQuery" if needed to resolve context or remove meta-document phrasing.`;

function buildContext(passages) {
  const allowedTags = [...new Set(passages.map((p) => p.citation))].join(', ');
  const body = passages
    .map(
      (p, i) =>
        `--- Passage ${i + 1} ---\nCite as: ${p.citation}\nPublisher: ${p.publisher} | Knowledge base: ${p.namespace} | Relevance: ${p.scores.rerank}\n${p.text}`
    )
    .join('\n\n');
  return `ALLOWED CITATIONS (use ONLY these exact tags): ${allowedTags}\n\n${body}`;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function sanitizeHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 1500) }));
}

/**
 * Filter retrieved passages for the relevance gate.
 * Primary rule: calibrated bge-reranker-v2-m3 probability >= threshold (default 0.15).
 * Conservative hybrid corroboration fallback: if a passage has strong dense (>= 0.42) AND
 * strong lexical (>= 2.5) agreement with non-trivial rerank (>= 0.05), accept it and
 * explicitly label `gateMode: 'hybrid-corroborated'` and `passedThresholdCount: 0` so
 * metadata is always 100% consistent with the actual evidence used.
 */
export function selectRelevantPassages(results, threshold = config.rag.minRelevanceScore) {
  const primary = results.filter((r) => (r.scores?.rerank ?? 0) >= threshold);
  const passedThresholdCount = primary.length;

  if (primary.length) {
    return {
      passages: primary.map((p) => ({ ...p, acceptedBy: 'rerank-threshold' })),
      gateMode: 'rerank-threshold',
      passedThresholdCount,
    };
  }

  const corroborated = results.filter(
    (r) =>
      (r.scores?.rerank ?? 0) >= 0.05 &&
      (r.scores?.dense ?? 0) >= 0.42 &&
      (r.scores?.lexical ?? 0) >= 2.5
  );
  if (corroborated.length) {
    return {
      passages: corroborated.map((p) => ({ ...p, acceptedBy: 'hybrid-corroborated' })),
      gateMode: 'hybrid-corroborated',
      passedThresholdCount: 0,
    };
  }
  return { passages: [], gateMode: 'refused', passedThresholdCount: 0 };
}

/** Merge passages from multiple sub-queries, deduplicating by namespace:id and keeping highest rerank score. */
export function mergePassages(passageLists, maxTotal = 8) {
  const byKey = new Map();
  for (const list of passageLists) {
    for (const p of list) {
      const key = `${p.namespace || ''}:${p.id}`;
      const existing = byKey.get(key);
      if (!existing || (p.scores?.rerank ?? 0) > (existing.scores?.rerank ?? 0)) {
        byKey.set(key, p);
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (b.scores?.rerank ?? 0) - (a.scores?.rerank ?? 0))
    .slice(0, maxTotal)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

/** Check every [Title, p. N] (including 【Title, p. N】 and multi-page forms like pp. 9-10) against supplied passages. */
export function validateCitations(answer, passages) {
  const allowed = new Map(passages.map((p) => [`${norm(p.title)}|${p.page}`, p]));
  const found = [
    ...answer.matchAll(/[\[【]([^\[\]【】]+?),\s*p(?:ages?|p\.?|\.)\s*([0-9]+(?:\s*[-–,]\s*[0-9]+)*)[\]】]/gi),
  ];
  const valid = new Map();
  const invalid = [];

  for (const [raw, title, pageExpr] of found) {
    const pages = [];
    for (const part of pageExpr.split(/\s*,\s*/)) {
      const range = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end >= start && end - start <= 10) {
          for (let n = start; n <= end; n++) pages.push(n);
        } else {
          pages.push(start, end);
        }
      } else if (/^\d+$/.test(part)) {
        pages.push(Number(part));
      }
    }

    for (const pageNum of pages) {
      const p = allowed.get(`${norm(title)}|${pageNum}`);
      if (p) {
        valid.set(p.citation, {
          citation: p.citation,
          title: p.title,
          page: p.page,
          namespace: p.namespace,
          publisher: p.publisher,
          sourceUrl: p.sourceUrl,
        });
      } else {
        invalid.push(pages.length > 1 ? `[${title.trim()}, p. ${pageNum}]` : raw);
      }
    }
  }
  return {
    citations: [...valid.values()],
    invalidCitations: [...new Set(invalid)],
    citationCount: found.length,
  };
}

/** True when the user explicitly asks about uploaded documents/reports/PDFs. */
export function isExplicitDocumentQuery(question = '') {
  return /\b(?:the|this|my|uploaded|attached)\s+(?:report|document|documents|pdf|pdfs|paper|manual|guide|file|source|sources|knowledge\s*base)\b|\baccording\s+to\s+the\s+(?:report|document|pdf|text|source)\b/i.test(
    question
  );
}

/**
 * Lightweight LLM router & query planner:
 * - Decides chat vs. RAG
 * - Resolves ordinal/contextual follow-up references across full recent history
 * - Decomposes comparison questions into per-concept sub-queries
 * - Expands broad document-summary questions into complementary section sub-queries
 */
export async function routeConversation(question, scope, groqClient, history = []) {
  if (RED_FLAGS.some((f) => question.toLowerCase().includes(f))) {
    return { route: 'rag', intent: 'document_query', queryType: 'standard', standaloneQuery: '', subQueries: [], resolvedReference: '' };
  }
  const explicitDoc = isExplicitDocumentQuery(question);
  try {
    const recentHistory = sanitizeHistory(history).slice(-10);
    const historyBlock = recentHistory.length
      ? `Recent conversation (oldest to newest):\n${recentHistory
          .map((m, i) => `[Turn ${i + 1}] ${m.role === 'user' ? 'User' : 'AskMed'}: ${m.content.slice(0, 800)}`)
          .join('\n')}\n\n`
      : '';

    const res = await groqClient.chat.completions.create({
      model: config.groq.model,
      messages: [
        { role: 'system', content: ROUTER_PROMPT },
        { role: 'user', content: `${historyBlock}Active scope: ${scope}\nLatest user message: ${question}` },
      ],
      temperature: 0,
      max_completion_tokens: 1024,
      reasoning_effort: 'low',
      include_reasoning: false,
      response_format: { type: 'json_object' },
    });

    const raw = (res.choices?.[0]?.message?.content || '').trim();
    const parsed = JSON.parse(raw);

    // 1. Strict healthcare-only domain guard (runs before chat, RAG, and web search)
    if (parsed?.route === 'out_of_domain' || parsed?.intent === 'out_of_domain') {
      return {
        route: 'out_of_domain',
        intent: 'out_of_domain',
        queryType: 'standard',
        standaloneQuery: '',
        subQueries: [],
        resolvedReference: '',
        usage: res.usage,
      };
    }

    const PURE_CHAT_INTENTS = ['greeting', 'thanks', 'goodbye', 'capability'];
    if (parsed?.route === 'chat' && !explicitDoc && PURE_CHAT_INTENTS.includes(parsed.intent)) {
      return {
        route: 'chat',
        intent: parsed.intent,
        queryType: 'standard',
        standaloneQuery: '',
        subQueries: [],
        resolvedReference: '',
        inlineReply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : null,
        usage: res.usage,
      };
    }

    const queryType = ['comparison', 'summary', 'standard'].includes(parsed?.queryType)
      ? parsed.queryType
      : 'standard';
    const subQueries = Array.isArray(parsed?.subQueries)
      ? parsed.subQueries
          .filter((s) => typeof s === 'string' && s.trim().length >= 3)
          .map((s) => s.trim())
          .slice(0, 4)
      : [];

    return {
      route: 'rag',
      intent: parsed?.intent === 'follow_up' ? 'follow_up' : 'document_query',
      queryType,
      standaloneQuery:
        typeof parsed?.standaloneQuery === 'string' && parsed.standaloneQuery.trim().length >= 3
          ? parsed.standaloneQuery.trim()
          : '',
      subQueries,
      resolvedReference:
        typeof parsed?.resolvedReference === 'string' ? parsed.resolvedReference.trim() : '',
      usage: res.usage,
    };
  } catch (err) {
    console.warn(`[rag] router fallback to RAG: ${err.message}`);
    return { route: 'rag', intent: 'document_query', queryType: 'standard', standaloneQuery: '', subQueries: [], resolvedReference: '' };
  }
}

async function generateConversationalReply(question, scope, history, groqClient) {
  const tGen = Date.now();
  const messages = [
    {
      role: 'system',
      content: `${CONVERSATIONAL_SYSTEM_PROMPT}\n\nActive document scope for this chat: "${scope}".`,
    },
    ...sanitizeHistory(history),
    { role: 'user', content: question },
  ];
  const response = await groqClient.chat.completions.create({
    model: config.groq.model,
    messages,
    temperature: 0.7,
    max_completion_tokens: 1024,
    reasoning_effort: 'low',
    include_reasoning: false,
  });
  return {
    answer: (response.choices?.[0]?.message?.content || '').trim(),
    tookMs: Date.now() - tGen,
    usage: response.usage,
  };
}

/**
 * Execute retrieval for standard, comparison (per-concept), or summary (multi-query) turns,
 * returning consistent retrieval metadata and strictly gated accepted passages.
 */
async function executeRetrievalPlan({ question, decision, scope, topK, threshold, retrieveFn }) {
  const { queryType, standaloneQuery, subQueries = [] } = decision;

  // Multi-concept comparison: retrieve & gate EACH concept independently so we never answer
  // if one side genuinely has no supporting evidence.
  if (queryType === 'comparison' && subQueries.length >= 2) {
    const perConcept = await Promise.all(
      subQueries.map(async (sq) => {
        const { results, stats } = await retrieveFn(sq, { scope, topK });
        const gate = selectRelevantPassages(results, threshold);
        return { query: sq, results, stats, ...gate };
      })
    );

    const allCandidates = mergePassages(perConcept.map((c) => c.results), 10);
    const missingConcepts = perConcept.filter((c) => !c.passages.length).map((c) => c.query);
    const mergedAccepted = missingConcepts.length
      ? []
      : mergePassages(perConcept.map((c) => c.passages), Math.max(topK, 6));

    const passedThresholdCount = mergedAccepted.filter((p) => (p.scores?.rerank ?? 0) >= threshold).length;
    const gateMode = missingConcepts.length
      ? 'refused'
      : passedThresholdCount === mergedAccepted.length
        ? 'rerank-threshold'
        : 'hybrid-corroborated';

    return {
      passages: mergedAccepted,
      allCandidates,
      missingConcepts,
      retrieval: {
        ...(perConcept[0]?.stats || {}),
        queryType: 'comparison',
        subQueries,
        threshold,
        gateMode,
        retrieved: allCandidates.length,
        passedThreshold: passedThresholdCount,
        accepted: mergedAccepted.length,
        topScore: allCandidates[0]?.scores.rerank ?? null,
        acceptedTopScore: mergedAccepted[0]?.scores.rerank ?? null,
        missingConcepts: missingConcepts.length ? missingConcepts : undefined,
      },
    };
  }

  // Broad summary / overview: run complementary sub-queries and merge diverse accepted sections
  if (queryType === 'summary' && subQueries.length >= 2) {
    const perSub = await Promise.all(
      subQueries.map(async (sq) => {
        const { results, stats } = await retrieveFn(sq, { scope, topK });
        const gate = selectRelevantPassages(results, threshold);
        return { query: sq, results, stats, ...gate };
      })
    );

    const allCandidates = mergePassages(perSub.map((s) => s.results), 12);
    const mergedAccepted = mergePassages(perSub.map((s) => s.passages), Math.max(topK, 8));
    const passedThresholdCount = mergedAccepted.filter((p) => (p.scores?.rerank ?? 0) >= threshold).length;
    const gateMode = !mergedAccepted.length
      ? 'refused'
      : passedThresholdCount > 0
        ? 'rerank-threshold'
        : 'hybrid-corroborated';

    return {
      passages: mergedAccepted,
      allCandidates,
      missingConcepts: [],
      retrieval: {
        ...(perSub[0]?.stats || {}),
        queryType: 'summary',
        subQueries,
        threshold,
        gateMode,
        retrieved: allCandidates.length,
        passedThreshold: passedThresholdCount,
        accepted: mergedAccepted.length,
        topScore: allCandidates[0]?.scores.rerank ?? null,
        acceptedTopScore: mergedAccepted[0]?.scores.rerank ?? null,
      },
    };
  }

  // Standard single-query retrieval (with optional follow-up standaloneQuery rewrite)
  const retrievalQuery = standaloneQuery || question;
  const { results, stats } = await retrieveFn(retrievalQuery, { scope, topK });
  const { passages, gateMode, passedThresholdCount } = selectRelevantPassages(results, threshold);

  return {
    passages,
    allCandidates: results,
    missingConcepts: [],
    retrieval: {
      ...stats,
      queryType: 'standard',
      rewrittenQuery: standaloneQuery || undefined,
      resolvedReference: decision.resolvedReference || undefined,
      threshold,
      gateMode,
      retrieved: results.length,
      passedThreshold: passedThresholdCount,
      accepted: passages.length,
      topScore: results[0]?.scores.rerank ?? null,
      acceptedTopScore: passages[0]?.scores.rerank ?? null,
    },
  };
}

export async function answerQuestion({ question, scope = 'both', topK = 5, history = [] }, deps = {}) {
  const t0 = Date.now();
  const q = question.trim();
  const cleanHistory = sanitizeHistory(history);
  const threshold = config.rag.minRelevanceScore;
  const emergency = RED_FLAGS.some((f) => q.toLowerCase().includes(f));
  const retrieveFn = deps.retrieve || retrieve;
  const groqClient = deps.groq || getGroq();

  // 0. Strict healthcare-only domain guard + lightweight routing
  const decision = await routeConversation(q, scope, groqClient, cleanHistory);

  if (decision.route === 'out_of_domain') {
    return {
      question: q,
      scope,
      mode: 'guard',
      sourceType: 'guard',
      intent: 'out_of_domain',
      refused: true,
      canSearchWeb: false,
      grounded: false,
      reason: 'OUT_OF_DOMAIN',
      answer: OUT_OF_DOMAIN_MESSAGE,
      citations: [],
      warnings: [],
      sources: [],
      emergency: false,
      disclaimer: DISCLAIMER,
      retrieval: {
        skipped: true,
        reason: 'OUT_OF_DOMAIN',
        threshold,
        gateMode: 'skipped',
        retrieved: 0,
        passedThreshold: 0,
        accepted: 0,
        topScore: null,
        acceptedTopScore: null,
      },
      tookMs: Date.now() - t0,
    };
  }

  if (decision.route === 'chat') {
    let answer = decision.inlineReply;
    let genTookMs = Date.now() - t0;
    let usage = decision.usage;

    if (!answer) {
      const gen = await generateConversationalReply(q, scope, cleanHistory, groqClient);
      answer = gen.answer;
      genTookMs = gen.tookMs;
      usage = gen.usage;
    }

    return {
      question: q,
      scope,
      mode: 'chat',
      intent: decision.intent,
      conversational: true,
      refused: false,
      grounded: false,
      answer,
      citations: [],
      warnings: [],
      sources: [],
      emergency: false,
      disclaimer: DISCLAIMER,
      retrieval: {
        skipped: true,
        reason: `CONVERSATIONAL_${decision.intent.toUpperCase()}`,
        threshold,
        gateMode: 'skipped',
        retrieved: 0,
        passedThreshold: 0,
        accepted: 0,
        topScore: null,
        acceptedTopScore: null,
      },
      generation: {
        provider: 'groq',
        model: config.groq.model,
        tookMs: genTookMs,
        promptTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
      },
      tookMs: Date.now() - t0,
    };
  }

  // 1 + 2. Execute retrieval plan (standard / comparison / summary) + relevance gate
  const { passages, allCandidates, missingConcepts, retrieval } = await executeRetrievalPlan({
    question: q,
    decision,
    scope,
    topK,
    threshold,
    retrieveFn,
  });

  if (!passages.length) {
    console.log(
      `[rag] refusal (${missingConcepts.length ? 'INCOMPLETE_COMPARISON_EVIDENCE' : allCandidates.length ? 'LOW_RELEVANCE' : 'NO_DOCUMENTS'}) ` +
        `scope=${scope} top=${allCandidates[0]?.scores.rerank ?? 'none'} threshold=${threshold}` +
        (missingConcepts.length ? ` missing=${missingConcepts.join('; ')}` : '')
    );
    const refusalText = missingConcepts.length
      ? "I couldn't find enough information in your selected documents to compare both sides reliably. I don't want to guess. Would you like me to search the web for an answer?"
      : "I couldn't find a reliable answer to that in your selected documents. I don't want to guess. Would you like me to search the web for an answer?";
    return {
      question: q,
      scope,
      mode: 'rag',
      sourceType: 'documents',
      intent: decision.intent,
      refused: true,
      canSearchWeb: true,
      grounded: false,
      reason: missingConcepts.length
        ? 'INCOMPLETE_COMPARISON_EVIDENCE'
        : allCandidates.length
          ? 'LOW_RELEVANCE'
          : 'NO_DOCUMENTS',
      answer: (emergency ? EMERGENCY_NOTICE + '\n\n' : '') + refusalText,
      citations: [],
      sources: allCandidates.map(({ text, ...r }) => ({ ...r, snippet: text.slice(0, 200) })),
      emergency,
      disclaimer: DISCLAIMER,
      retrieval,
      tookMs: Date.now() - t0,
    };
  }

  // 3. Grounded generation (retaining original user question + optional resolved reference hint)
  const refHint = decision.resolvedReference
    ? `RESOLVED CONTEXT REFERENCE: ${decision.resolvedReference}\n\n`
    : '';
  const userPrompt =
    `CONTEXT:\n${buildContext(passages)}\n\n${refHint}QUESTION: ${q}\n\n` +
    'Answer using ONLY the CONTEXT above. Every factual sentence or comparison point MUST include an exact inline citation from ALLOWED CITATIONS (e.g. [Source, p. X]).';
  const tGen = Date.now();
  const baseMessages = [
    { role: 'system', content: RAG_SYSTEM_PROMPT },
    ...cleanHistory.slice(-8),
    { role: 'user', content: userPrompt },
  ];
  let response = await groqClient.chat.completions.create({
    model: config.groq.model,
    messages: baseMessages,
    temperature: 0.15,
    max_completion_tokens: 2048,
    reasoning_effort: 'medium',
    include_reasoning: false,
  });
  let answer = (response.choices?.[0]?.message?.content || '')
    .replace(/【([^【】]+?)】/g, '[$1]')
    .trim();

  // 4. Post-generation grounding checks (strictly verified against accepted passages)
  let check = validateCitations(answer, passages);
  let insufficient = /could not find enough information/i.test(answer);

  // If the model produced a substantive answer from accepted passages but omitted inline citations,
  // run one targeted citation-revision pass using ONLY the supplied context & allowlist (never fabricating).
  if (!insufficient && passages.length > 0 && check.citationCount === 0) {
    try {
      const retry = await groqClient.chat.completions.create({
        model: config.groq.model,
        messages: [
          ...baseMessages,
          { role: 'assistant', content: answer },
          {
            role: 'user',
            content:
              'Your previous draft omitted inline citations. Rewrite it using ONLY facts supported by the CONTEXT above: ' +
              'add exact inline citations from ALLOWED CITATIONS to every supported factual claim, and remove any claim not directly supported by CONTEXT. ' +
              'If CONTEXT does not support answering, say "I could not find enough information in the available sources to answer this."',
          },
        ],
        temperature: 0,
        max_completion_tokens: 2048,
        reasoning_effort: 'low',
        include_reasoning: false,
      });
      const revised = (retry.choices?.[0]?.message?.content || '')
        .replace(/【([^【】]+?)】/g, '[$1]')
        .trim();
      if (revised) {
        answer = revised;
        response = retry;
        check = validateCitations(answer, passages);
        insufficient = /could not find enough information/i.test(answer);
      }
    } catch (err) {
      console.warn(`[rag] citation revision pass failed: ${err.message}`);
    }
  }

  const { citations, invalidCitations, citationCount } = check;
  const grounded = !insufficient && passages.length > 0 && citations.length > 0 && invalidCitations.length === 0;
  const warnings = [];
  if (!citationCount && !insufficient) warnings.push('Answer contains no inline citations - treat with caution.');
  if (invalidCitations.length) warnings.push(`Answer cited sources that were not retrieved: ${invalidCitations.join(', ')}`);

  if (emergency) answer = `${EMERGENCY_NOTICE}\n\n${answer}`;

  return {
    question: q,
    scope,
    mode: 'rag',
    sourceType: 'documents',
    intent: decision.intent,
    refused: insufficient,
    canSearchWeb: insufficient,
    grounded,
    answer,
    citations,
    warnings,
    sources: passages.map(({ text, ...r }) => ({ ...r, snippet: text.slice(0, 300) })),
    emergency,
    disclaimer: DISCLAIMER,
    retrieval,
    generation: {
      provider: 'groq',
      model: config.groq.model,
      tookMs: Date.now() - tGen,
      promptTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    },
    tookMs: Date.now() - t0,
  };
}
