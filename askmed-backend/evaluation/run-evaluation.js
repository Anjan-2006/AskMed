#!/usr/bin/env node
// evaluation/run-evaluation.js
// Reproducible RAG evaluation runner reusing AskMed's production answerQuestion() pipeline.
// Usage:
//   node --env-file=.env evaluation/run-evaluation.js              # run all 30 questions
//   node --env-file=.env evaluation/run-evaluation.js --limit 6    # bounded subset validation
//   node --env-file=.env evaluation/run-evaluation.js --ids Q01,Q09,Q20,Q23,Q28
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerQuestion } from '../services/ragService.js';
import { config } from '../config/clients.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.join(__dirname, 'dataset.json');
const RESULTS_PATH = path.join(__dirname, 'results.json');
const REPORT_PATH = path.join(__dirname, 'evaluation-report.md');

function parseArgs(argv) {
  const opts = { limit: null, ids: null, delayMs: 800, rescore: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) opts.limit = Number(argv[++i]);
    else if (argv[i] === '--ids' && argv[i + 1]) opts.ids = new Set(argv[++i].split(',').map((s) => s.trim()));
    else if (argv[i] === '--delay' && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    else if (argv[i] === '--rescore') opts.rescore = true;
  }
  return opts;
}

function normalizeText(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2009\u202F\s]+/g, ' ')
    .replace(/(\d)\s+%/g, '$1%')
    .replace(/(\d)\s+(\d{3})\b/g, '$1$2');
}

function scoreKeyFacts(answer = '', expectedKeyFacts = []) {
  if (!expectedKeyFacts.length) return { matched: [], missing: [], ratio: 1 };
  const lower = normalizeText(answer);
  const dehyphenated = lower.replace(/-/g, ' ');
  const compact = lower.replace(/[-\s]+/g, '');
  const matched = [];
  const missing = [];
  for (const fact of expectedKeyFacts) {
    const f = normalizeText(fact);
    // Allow simple spelling/hyphenation variants (fibre/fiber, 6 months/six months, breast-milk/breastmilk)
    const variants = [f];
    if (f === 'fibre') variants.push('fiber');
    if (f === 'first six months') variants.push('first 6 months', '0 to 6 months', '0-6 months');
    if (f === '6 months') variants.push('six months');
    if (f === 'free sugar') variants.push('free sugars');
    if (f === 'weight control') variants.push('body weight', 'weight');
    if (f === 'noncommunicable diseases') variants.push('non-communicable diseases', 'ncd', 'chronic disease');
    if (f === 'exclusive breastfeeding') variants.push('only breastmilk', 'only breast-milk', 'only breast milk');
    const hit = variants.some((v) => {
      const vDehyphen = v.replace(/-/g, ' ');
      const vCompact = v.replace(/[-\s]+/g, '');
      return lower.includes(v) || dehyphenated.includes(vDehyphen) || (vCompact.length >= 6 && compact.includes(vCompact));
    });
    if (hit) matched.push(fact);
    else missing.push(fact);
  }
  return { matched, missing, ratio: matched.length / expectedKeyFacts.length };
}

function computeReciprocalRank(retrievedPages, expectedPages) {
  if (!expectedPages.length) return null;
  const gold = new Set(expectedPages);
  for (let i = 0; i < retrievedPages.length; i++) {
    if (gold.has(retrievedPages[i])) return 1 / (i + 1);
  }
  return 0;
}

function classifyFailure(item, res, metrics) {
  if (item.expectedBehavior === 'refuse') {
    if (!res.refused) return 'Unsupported-question handling (false answer)';
    return null;
  }
  if (res.refused) {
    if (!metrics.recallAt5) return 'Retrieval / Reranking';
    return 'Relevance gate';
  }
  if (!metrics.recallAt5) return 'Retrieval / Reranking';
  if (!metrics.citationAccurate) return 'Citation generation or validation';
  if (!metrics.answerCorrect) return item.category === 'follow_up' ? 'Query rewriting / Context' : 'Answer generation';
  return null;
}

function pct(num, den) {
  return den ? `${((num / den) * 100).toFixed(1)}% (${num}/${den})` : 'N/A (0/0)';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  const scope = dataset.sourceDocument.pineconeNamespace;

  let questions = dataset.questions;
  if (opts.ids) questions = questions.filter((q) => opts.ids.has(q.id));
  if (opts.limit) questions = questions.slice(0, opts.limit);

  const existingById = new Map();
  if (opts.rescore && fs.existsSync(RESULTS_PATH)) {
    const prev = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    for (const r of prev.results || []) existingById.set(r.id, r);
  }

  console.log(
    `[eval] ${opts.rescore ? 'Re-scoring' : 'Running'} ${questions.length}/${dataset.questions.length} questions against namespace="${scope}" ` +
      `(model=${config.groq.model}, threshold=${config.rag.minRelevanceScore})`
  );

  const records = [];
  for (let i = 0; i < questions.length; i++) {
    const item = questions[i];
    const t0 = Date.now();
    let res;
    let error = null;
    let tookMs = 0;

    if (opts.rescore && existingById.has(item.id)) {
      const prev = existingById.get(item.id);
      error = prev.actual.error || null;
      tookMs = prev.tookMs || 0;
      res = {
        mode: prev.actual.mode,
        intent: prev.actual.intent,
        refused: prev.actual.refused,
        grounded: prev.actual.grounded,
        canSearchWeb: prev.actual.canSearchWeb,
        retrieval: { gateMode: prev.actual.gateMode, topScore: prev.actual.topScore },
        sources: (prev.actual.retrievedPages || []).map((page) => ({ page })),
        citations: (prev.actual.citedPages || []).map((page) => ({ page })),
        warnings: prev.actual.warnings || [],
        answer: prev.actual.answer,
      };
    } else {
      try {
        res = await answerQuestion({
          question: item.question,
          scope,
          topK: 5,
          history: item.conversationHistory || [],
        });
      } catch (err) {
        error = err.message;
        res = { refused: true, grounded: false, answer: '', citations: [], sources: [], retrieval: {} };
      }
      tookMs = Date.now() - t0;
    }

    const retrievedSources = res.sources || [];
    const retrievedPages = retrievedSources.map((s) => Number(s.page));
    const citedPages = [...new Set((res.citations || []).map((c) => Number(c.page)))];
    const goldSet = new Set(item.expectedPages);

    const rr = computeReciprocalRank(retrievedPages, item.expectedPages);
    const recallAt5 = item.answerable ? retrievedPages.slice(0, 5).some((p) => goldSet.has(p)) : null;
    const factCheck = item.answerable ? scoreKeyFacts(res.answer, item.expectedKeyFacts) : null;
    const answerCorrect = item.answerable ? !res.refused && factCheck.ratio >= 0.75 : null;
    const citationAccurate = item.answerable
      ? !res.refused &&
        citedPages.length > 0 &&
        res.grounded === true &&
        citedPages.some((p) => goldSet.has(p))
      : null;
    const faithful = item.answerable ? !res.refused && res.grounded === true && (res.warnings || []).length === 0 : null;
    const refusalCorrect = !item.answerable ? res.refused === true : null;
    const falseAnswer = !item.answerable ? res.refused === false : null;

    const metrics = {
      recallAt5,
      reciprocalRank: rr,
      answerCorrect,
      keyFactsMatched: factCheck?.matched || [],
      keyFactsMissing: factCheck?.missing || [],
      citationAccurate,
      faithful,
      refusalCorrect,
      falseAnswer,
    };

    const failureStage = error ? 'Runtime / API error' : classifyFailure(item, res, metrics);
    const passed = error ? false : failureStage === null;

    records.push({
      id: item.id,
      category: item.category,
      question: item.question,
      answerable: item.answerable,
      expectedBehavior: item.expectedBehavior,
      expectedPages: item.expectedPages,
      expectedKeyFacts: item.expectedKeyFacts,
      actual: {
        mode: res.mode,
        intent: res.intent,
        refused: Boolean(res.refused),
        grounded: Boolean(res.grounded),
        canSearchWeb: Boolean(res.canSearchWeb),
        gateMode: res.retrieval?.gateMode || null,
        topScore: res.retrieval?.topScore ?? null,
        retrievedPages,
        citedPages,
        warnings: res.warnings || [],
        answer: res.answer,
        error,
      },
      metrics,
      passed,
      failureStage,
      tookMs,
    });

    console.log(
      `  [${i + 1}/${questions.length}] ${item.id} (${item.category}) -> ` +
        `${passed ? 'PASS' : 'FAIL (' + failureStage + ')'} | ` +
        `refused=${Boolean(res.refused)} grounded=${Boolean(res.grounded)} top=${res.retrieval?.topScore ?? '-'} ` +
        `pages=${JSON.stringify(retrievedPages.slice(0, 5))} cited=${JSON.stringify(citedPages)}`
    );

    if (!opts.rescore && i < questions.length - 1 && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }

  // Aggregate metrics with exact denominators
  const answerable = records.filter((r) => r.answerable);
  const unsupported = records.filter((r) => !r.answerable);

  const recallHits = answerable.filter((r) => r.metrics.recallAt5).length;
  const retrievalFailures = answerable.length - recallHits;
  const mrrSum = answerable.reduce((acc, r) => acc + (r.metrics.reciprocalRank || 0), 0);
  const mrr = answerable.length ? Number((mrrSum / answerable.length).toFixed(4)) : null;

  const correctAnswers = answerable.filter((r) => r.metrics.answerCorrect).length;
  const faithfulAnswers = answerable.filter((r) => r.metrics.faithful).length;
  const accurateCitations = answerable.filter((r) => r.metrics.citationAccurate).length;
  const correctRefusals = unsupported.filter((r) => r.metrics.refusalCorrect).length;
  const falseAnswers = unsupported.filter((r) => r.metrics.falseAnswer).length;

  const summary = {
    runAt: new Date().toISOString(),
    model: config.groq.model,
    threshold: config.rag.minRelevanceScore,
    scope,
    totalEvaluated: records.length,
    answerableCount: answerable.length,
    unsupportedCount: unsupported.length,
    overallPassCount: records.filter((r) => r.passed).length,
    retrieval: {
      recallAt5: answerable.length ? Number((recallHits / answerable.length).toFixed(4)) : null,
      recallAt5Formatted: pct(recallHits, answerable.length),
      mrr,
      retrievalFailureCount: retrievalFailures,
    },
    generation: {
      answerCorrectness: answerable.length ? Number((correctAnswers / answerable.length).toFixed(4)) : null,
      answerCorrectnessFormatted: pct(correctAnswers, answerable.length),
      faithfulness: answerable.length ? Number((faithfulAnswers / answerable.length).toFixed(4)) : null,
      faithfulnessFormatted: pct(faithfulAnswers, answerable.length),
      citationAccuracy: answerable.length ? Number((accurateCitations / answerable.length).toFixed(4)) : null,
      citationAccuracyFormatted: pct(accurateCitations, answerable.length),
      refusalAccuracy: unsupported.length ? Number((correctRefusals / unsupported.length).toFixed(4)) : null,
      refusalAccuracyFormatted: pct(correctRefusals, unsupported.length),
      falseAnswerRate: unsupported.length ? Number((falseAnswers / unsupported.length).toFixed(4)) : null,
      falseAnswerRateFormatted: pct(falseAnswers, unsupported.length),
    },
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ summary, results: records }, null, 2));

  // Build readable Markdown report
  const failures = records.filter((r) => !r.passed);
  const categories = [...new Set(records.map((r) => r.category))];
  const catRows = categories
    .map((cat) => {
      const sub = records.filter((r) => r.category === cat);
      const p = sub.filter((r) => r.passed).length;
      return `| ${cat} | ${sub.length} | ${p}/${sub.length} (${((p / sub.length) * 100).toFixed(1)}%) |`;
    })
    .join('\n');

  const failTable = failures.length
    ? failures
        .map(
          (f) =>
            `| ${f.id} | ${f.expectedBehavior} (pages ${f.expectedPages.join(',') || 'none'}) | ` +
            `refused=${f.actual.refused}, grounded=${f.actual.grounded}, cited=[${f.actual.citedPages.join(',')}] | ` +
            `${f.failureStage} | top=${f.actual.topScore}, retrieved=[${f.actual.retrievedPages.join(',')}], missingFacts=[${f.metrics.keyFactsMissing.join(', ')}] |`
        )
        .join('\n')
    : '| — | — | No failures in this run | — | — |';

  const reportMd = `# AskMed RAG Evaluation Report

- **Run timestamp:** ${summary.runAt}
- **Model:** \`${summary.model}\`
- **Relevance threshold:** \`${summary.threshold}\`
- **Pinecone namespace:** \`${summary.scope}\` (\`who_healthy_diets.pdf.pdf\`, 56 chunks)
- **Questions evaluated:** ${summary.totalEvaluated} (${summary.answerableCount} answerable, ${summary.unsupportedCount} unsupported)

## Aggregate Metrics

### Retrieval (denominator: ${summary.answerableCount} answerable questions)
| Metric | Value |
|---|---|
| **Recall@5** | ${summary.retrieval.recallAt5Formatted} |
| **MRR** | ${summary.retrieval.mrr} |
| **Retrieval Failures** | ${summary.retrieval.retrievalFailureCount} |

### Generation & Grounding
| Metric | Denominator | Value |
|---|---|---|
| **Answer Correctness** (automated key-fact coverage ≥ 75%) | ${summary.answerableCount} answerable | ${summary.generation.answerCorrectnessFormatted} |
| **Faithfulness** (grounded=true, zero validator warnings) | ${summary.answerableCount} answerable | ${summary.generation.faithfulnessFormatted} |
| **Citation Accuracy** (valid gold-page citation present) | ${summary.answerableCount} answerable | ${summary.generation.citationAccuracyFormatted} |
| **Refusal Accuracy** | ${summary.unsupportedCount} unsupported | ${summary.generation.refusalAccuracyFormatted} |
| **False-Answer Rate** | ${summary.unsupportedCount} unsupported | ${summary.generation.falseAnswerRateFormatted} |

> **Rubric note:** Answer Correctness uses deterministic key-fact coverage (≥75% of ground-truth facts present in non-refused answer). Faithfulness checks strict citation validation against supplied passages with zero warnings. Human spot-check is recommended for nuanced phrasing.

## Breakdown by Category
| Category | Count | Pass Rate |
|---|---|---|
${catRows}

## Failure Analysis (${failures.length} failed)
| ID | Expected | Actual | Failure Stage | Evidence |
|---|---|---|---|---|
${failTable}

## Reproduce
\`\`\`bash
cd askmed-backend
node --env-file=.env evaluation/run-evaluation.js
\`\`\`
`;

  fs.writeFileSync(REPORT_PATH, reportMd);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

