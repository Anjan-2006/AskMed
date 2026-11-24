// services/batchService.js
// Multi-question batch answering built on top of the existing single-question RAG service.
// Preserves input order, isolates per-question errors/refusals, deduplicates identical
// questions, and enforces a configurable concurrency limit.
import { config } from '../config/clients.js';
import { answerQuestion } from './ragService.js';

const MAX_QUESTION_LEN = 1000;

/**
 * Parse a multiline string or array of strings into clean individual questions.
 * Supports one question per line, numbered lists ("1. ...", "2) ...", "Q1: ..."),
 * and bulleted lists ("- ...", "* ...", "• ..."). Ignores empty lines.
 */
export function parseBatchQuestions(input, maxQuestions = config.batch.maxQuestions) {
  let rawLines;
  if (Array.isArray(input)) {
    rawLines = input.flatMap((item) => (typeof item === 'string' ? item.split(/\r?\n/) : []));
  } else if (typeof input === 'string') {
    rawLines = input.split(/\r?\n/);
  } else {
    throw Object.assign(new Error('"questions" must be a non-empty array of strings or multiline text'), {
      status: 400,
    });
  }

  const questions = rawLines
    .map((line) =>
      line
        .trim()
        .replace(/^(?:q\s*\d+\s*[:.)\-]|\d+\s*[.)\-:]|[-*•–—])\s+/i, '')
        .trim()
    )
    .filter(Boolean);

  if (!questions.length) {
    throw Object.assign(new Error('No valid questions found in batch input'), { status: 400 });
  }
  if (questions.length > maxQuestions) {
    throw Object.assign(
      new Error(`Too many questions in one batch (${questions.length} > max ${maxQuestions})`),
      { status: 400 }
    );
  }
  const tooLong = questions.findIndex((q) => q.length > MAX_QUESTION_LEN);
  if (tooLong !== -1) {
    throw Object.assign(
      new Error(`Question #${tooLong + 1} exceeds ${MAX_QUESTION_LEN} characters`),
      { status: 400 }
    );
  }

  return questions;
}

/**
 * Answer a batch of questions independently through answerQuestion() with bounded concurrency.
 * - Preserves exact input order.
 * - Deduplicates identical questions (case-insensitive) so retrieval/LLM are not repeated.
 * - Never crashes the whole batch if an individual question fails or is refused.
 */
export async function answerBatch(
  { questions: rawInput, scope = 'both', topK = 5, concurrency = config.batch.concurrency },
  deps = {}
) {
  const t0 = Date.now();
  const questions = parseBatchQuestions(rawInput);
  const limit = Math.min(Math.max(parseInt(concurrency, 10) || config.batch.concurrency, 1), 5);
  const answerFn = deps.answerQuestion || answerQuestion;

  const results = new Array(questions.length);
  const cache = new Map(); // normalizedKey -> Promise<result>
  let deduplicatedCount = 0;

  // Assign each unique question a slot to run in the bounded worker pool,
  // while duplicates await the same promise.
  const uniqueTasks = [];
  const itemRefs = questions.map((question, index) => {
    const key = `${scope}::${question.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (cache.has(key)) {
      deduplicatedCount += 1;
      return { index, question, key, isDuplicate: true };
    }
    let resolveFn;
    const promise = new Promise((r) => (resolveFn = r));
    cache.set(key, promise);
    uniqueTasks.push({ question, key, resolveFn });
    return { index, question, key, isDuplicate: false };
  });

  // Bounded concurrency worker pool over unique questions
  let cursor = 0;
  async function worker() {
    while (cursor < uniqueTasks.length) {
      const task = uniqueTasks[cursor++];
      try {
        const res = await answerFn({ question: task.question, scope, topK });
        task.resolveFn({ ok: true, data: res });
      } catch (err) {
        task.resolveFn({
          ok: false,
          error: err?.message || 'Failed to answer question',
          status: err?.status || err?.statusCode || 500,
        });
      }
    }
  }

  const workerCount = Math.min(limit, uniqueTasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Assemble results in the exact input order without mixing citations/evidence
  for (const ref of itemRefs) {
    const outcome = await cache.get(ref.key);
    if (outcome.ok) {
      results[ref.index] = {
        index: ref.index + 1,
        ...outcome.data,
        question: ref.question,
        deduplicated: ref.isDuplicate,
      };
    } else {
      results[ref.index] = {
        index: ref.index + 1,
        question: ref.question,
        scope,
        error: outcome.error,
        status: outcome.status,
        refused: false,
        grounded: false,
        citations: [],
        sources: [],
        deduplicated: ref.isDuplicate,
      };
    }
  }

  const failed = results.filter((r) => Boolean(r.error)).length;
  const refused = results.filter((r) => !r.error && r.refused).length;
  const answered = results.length - failed - refused;

  return {
    scope,
    total: results.length,
    answered,
    refused,
    failed,
    deduplicated: deduplicatedCount,
    concurrency: limit,
    tookMs: Date.now() - t0,
    results,
  };
}

