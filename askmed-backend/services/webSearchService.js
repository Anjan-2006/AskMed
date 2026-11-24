// services/webSearchService.js
// Consent-based Tavily web search + Groq GPT-OSS-120B grounded answer synthesis.
// Only invoked when the user explicitly consents to searching the web.
import { config, getGroq } from '../config/clients.js';
import { DISCLAIMER, OUT_OF_DOMAIN_MESSAGE, routeConversation } from './ragService.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

const WEB_SYSTEM_PROMPT = `You are AskMed, an AI research assistant answering a question using live web search results after the user explicitly asked you to search the web.

STRICT RULES:
1. Answer concisely and clearly using ONLY the retrieved WEB SOURCES below. Do not invent facts or URLs.
2. Clearly frame your answer as coming from web sources (not from the user's uploaded documents).
3. Never mention relevance scores, search thresholds, API names, or internal diagnostics.
4. Preserve helpful factual details, numbers, and statistics that genuinely appear in the web sources.
5. If the web sources do not contain enough reliable information to answer, say clearly that you couldn't find enough reliable information online and avoid guessing.
6. For personal medical, legal, or critical decisions, advise consulting a qualified professional.`;

export function isTavilyConfigured(apiKey = config.tavily.apiKey) {
  return Boolean(
    typeof apiKey === 'string' &&
      apiKey.trim().length > 10 &&
      !/^(REPLACE_WITH|your_tavily)/i.test(apiKey.trim())
  );
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function sanitizeHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 1000) }));
}

/**
 * Query the official Tavily Search REST API (POST https://api.tavily.com/search).
 * Never exposes the API key or Tavily internal relevance scores to callers.
 */
export async function searchTavily(query, opts = {}, deps = {}) {
  const apiKey = opts.apiKey ?? config.tavily.apiKey;
  if (!isTavilyConfigured(apiKey)) {
    const err = new Error(
      "Web search isn't configured on the server yet. Please add TAVILY_API_KEY to the backend environment to enable web search."
    );
    err.status = 503;
    err.code = 'TAVILY_NOT_CONFIGURED';
    throw err;
  }

  const fetchFn = deps.fetch || fetch;
  const maxResults = Math.min(Math.max(opts.maxResults || config.tavily.maxResults || 5, 1), 10);
  const timeoutMs = opts.timeoutMs || config.tavily.timeoutMs || 20000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchFn(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        query: query.trim(),
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw Object.assign(new Error('Web search timed out. Please try again shortly.'), { status: 504 });
    }
    throw Object.assign(new Error('Unable to reach the web search service right now. Please try again.'), {
      status: 503,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Web search credentials were rejected. Please check TAVILY_API_KEY on the server.'), {
      status: 503,
    });
  }
  if (res.status === 429) {
    throw Object.assign(new Error('Web search rate limit reached. Please wait a moment and try again.'), {
      status: 429,
    });
  }
  if (!res.ok) {
    console.error(`[tavily] HTTP ${res.status}`);
    throw Object.assign(new Error('Web search encountered a temporary error. Please try again.'), { status: 502 });
  }

  const payload = await res.json().catch(() => ({}));
  const rawResults = Array.isArray(payload.results) ? payload.results : [];

  const seenUrls = new Set();
  const cleaned = [];
  for (const item of rawResults) {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const domain = extractDomain(url);
    const title = (typeof item?.title === 'string' && item.title.trim()) || domain || url;
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    cleaned.push({ title, url, domain, content });
    if (cleaned.length >= maxResults) break;
  }

  return cleaned;
}

/**
 * Perform consent-based Tavily search and generate a grounded web-sourced answer via Groq.
 */
export async function answerWithWebSearch({ question, history = [] }, deps = {}) {
  const t0 = Date.now();
  const q = question.trim();
  const searchFn = deps.searchTavily || searchTavily;
  const groqClient = deps.groq || getGroq();
  const routeFn = deps.routeConversation || routeConversation;

  // Enforce strict healthcare-only domain guard even when user explicitly requests web search.
  const decision = await routeFn(q, 'both', groqClient, history);
  if (decision?.route === 'out_of_domain') {
    return {
      question: q,
      mode: 'guard',
      sourceType: 'guard',
      intent: 'out_of_domain',
      refused: true,
      canSearchWeb: false,
      grounded: false,
      reason: 'OUT_OF_DOMAIN',
      answer: OUT_OF_DOMAIN_MESSAGE,
      webSources: [],
      citations: [],
      disclaimer: DISCLAIMER,
      tookMs: Date.now() - t0,
    };
  }

  const results = await searchFn(q, { maxResults: config.tavily.maxResults });

  if (!results.length) {
    return {
      question: q,
      mode: 'web',
      sourceType: 'web',
      refused: true,
      grounded: false,
      answer: "I searched the web, but couldn't find enough reliable information to answer that confidently.",
      webSources: [],
      citations: [],
      disclaimer: DISCLAIMER,
      tookMs: Date.now() - t0,
    };
  }

  const contextBlock = results
    .map(
      (r, i) =>
        `--- Web Source ${i + 1} ---\nTitle: ${r.title}\nWebsite: ${r.domain}\nURL: ${r.url}\nExcerpt: ${r.content.slice(0, 1200)}`
    )
    .join('\n\n');

  const response = await groqClient.chat.completions.create({
    model: config.groq.model,
    messages: [
      { role: 'system', content: WEB_SYSTEM_PROMPT },
      ...sanitizeHistory(history),
      {
        role: 'user',
        content: `WEB SOURCES:\n${contextBlock}\n\nQUESTION: ${q}\n\nProvide a concise, well-structured answer grounded only in the web sources above.`,
      },
    ],
    temperature: 0.2,
    max_completion_tokens: 1500,
    reasoning_effort: 'low',
    include_reasoning: false,
  });

  const answer = (response.choices?.[0]?.message?.content || '')
    .replace(/【[^【】]*†[^【】]*】/g, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
  const webSources = results.map(({ title, url, domain }) => ({ title, url, domain }));

  return {
    question: q,
    mode: 'web',
    sourceType: 'web',
    refused: false,
    grounded: true,
    answer,
    webSources,
    citations: [],
    disclaimer: DISCLAIMER,
    tookMs: Date.now() - t0,
  };
}

