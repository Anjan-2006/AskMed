import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQueryForRetrieval } from '../services/retrieveService.js';
import { answerQuestion, selectRelevantPassages, validateCitations } from '../services/ragService.js';
import { answerBatch, parseBatchQuestions } from '../services/batchService.js';
import { config } from '../config/clients.js';

/* ------------------ 1. Query Normalization & Reranker Gate ------------------ */

test('normalizeQueryForRetrieval strips meta-document framing for cross-encoder reranking', () => {
  assert.equal(
    normalizeQueryForRetrieval('According to the report, why is dietary adequacy important?'),
    'why is dietary adequacy important?'
  );
  assert.equal(
    normalizeQueryForRetrieval('What does the report mean by a balanced diet?'),
    'What is a balanced diet?'
  );
  assert.equal(
    normalizeQueryForRetrieval('What does the document say about food safety?'),
    'food safety?'
  );
  // Unrelated queries remain untouched
  assert.equal(
    normalizeQueryForRetrieval('Who won the 2018 football World Cup?'),
    'Who won the 2018 football World Cup?'
  );
});

test('selectRelevantPassages passes calibrated rerank >= 0.15 and conservative hybrid corroboration', () => {
  // Normal passing passage (after query normalization)
  const adequate = {
    page: 10,
    scores: { rerank: 0.3694, dense: 0.4501, lexical: 3.1835 },
  };
  const r1 = selectRelevantPassages([adequate], 0.15);
  assert.equal(r1.gateMode, 'rerank-threshold');
  assert.equal(r1.passages.length, 1);

  // Borderline rerank with strong dense + lexical corroboration
  const corroborated = {
    page: 10,
    scores: { rerank: 0.0711, dense: 0.4501, lexical: 3.1398 },
  };
  const r2 = selectRelevantPassages([corroborated], 0.15);
  assert.equal(r2.gateMode, 'hybrid-corroborated');
  assert.equal(r2.passages.length, 1);

  // Genuinely unrelated query MUST still be refused
  const unrelated = {
    page: 4,
    scores: { rerank: 0.0003, dense: 0.0761, lexical: 1.43 },
  };
  const r3 = selectRelevantPassages([unrelated], 0.15);
  assert.equal(r3.gateMode, 'refused');
  assert.equal(r3.passages.length, 0);
});

/* ------------------ 2. Citation Validation & Grounding ------------------ */

test('validateCitations flags hallucinated page numbers (e.g. p. 3 not in retrieved context)', () => {
  const passages = [
    {
      title: 'WHO-FAO Healthy Diets Report',
      page: 9,
      citation: '[WHO-FAO Healthy Diets Report, p. 9]',
      namespace: 'builtin',
      publisher: 'WHO',
      sourceUrl: '',
    },
  ];
  const answer =
    'Foods must be safe to avoid adverse health effects. [WHO-FAO Healthy Diets Report, p. 9] ' +
    'This is also discussed earlier. [WHO-FAO Healthy Diets Report, p. 3]';

  const v = validateCitations(answer, passages);
  assert.equal(v.citations.length, 1);
  assert.equal(v.citations[0].page, 9);
  assert.deepEqual(v.invalidCitations, ['[WHO-FAO Healthy Diets Report, p. 3]']);
});

test('validateCitations handles multi-page citations and flags missing pages in ranges', () => {
  const passages = [
    { title: 'WHO-FAO Healthy Diets Report', page: 9, citation: '[WHO-FAO Healthy Diets Report, p. 9]', namespace: 'builtin' },
    { title: 'WHO-FAO Healthy Diets Report', page: 10, citation: '[WHO-FAO Healthy Diets Report, p. 10]', namespace: 'builtin' },
  ];
  const vOk = validateCitations('Supported text [WHO-FAO Healthy Diets Report, pp. 9-10].', passages);
  assert.equal(vOk.citations.length, 2);
  assert.equal(vOk.invalidCitations.length, 0);

  const vBad = validateCitations('Supported text [WHO-FAO Healthy Diets Report, pp. 9-11].', passages);
  assert.deepEqual(vBad.invalidCitations, ['[WHO-FAO Healthy Diets Report, p. 11]']);

  const vFullWidth = validateCitations('Balanced diet info【WHO-FAO Healthy Diets Report, p. 9】.', passages);
  assert.equal(vFullWidth.citations.length, 1);
  assert.equal(vFullWidth.invalidCitations.length, 0);
});

test('answerQuestion keeps grounded=false when LLM cites an unretrieved page', async () => {
  const passage = {
    rank: 1,
    id: 'builtin-who#p9#c0',
    namespace: 'builtin',
    title: 'WHO-FAO Healthy Diets Report',
    source: 'who_healthy_diets.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 9,
    citation: '[WHO-FAO Healthy Diets Report, p. 9]',
    scores: { rerank: 0.94, dense: 0.44, lexical: 4.2 },
    text: 'Diets can only be healthy if foods and beverages are safe.',
  };
  const groq = {
    chat: {
      completions: {
        create: async (params) => ({
          choices: [
            {
              message: {
                content:
                  params.response_format?.type === 'json_object'
                    ? JSON.stringify({ route: 'rag' })
                    : 'Food safety is essential [WHO-FAO Healthy Diets Report, p. 3].',
              },
            },
          ],
        }),
      },
    },
  };
  const res = await answerQuestion(
    { question: 'Why is food safety essential?', scope: 'builtin' },
    { retrieve: async () => ({ results: [passage], stats: {} }), groq }
  );
  assert.equal(res.grounded, false);
  assert.equal(res.citations.length, 0);
  assert.ok(res.warnings.some((w) => w.includes('p. 3')));
});

/* ------------------ 3. Batch Parsing & Batch Execution ------------------ */

test('parseBatchQuestions handles multiline, numbered, bulleted, and empty lines', () => {
  const input = `
    1. What are the four core principles of healthy diets?

    2) Why is dietary adequacy important?
    - What does a balanced diet mean?
    Q4: Why is food safety essential?
  `;
  const parsed = parseBatchQuestions(input);
  assert.deepEqual(parsed, [
    'What are the four core principles of healthy diets?',
    'Why is dietary adequacy important?',
    'What does a balanced diet mean?',
    'Why is food safety essential?',
  ]);

  assert.throws(() => parseBatchQuestions('   \n  \n'), /No valid questions/);
  assert.throws(() => parseBatchQuestions(null), /must be a non-empty array/);
});

test('answerBatch preserves order, isolates refusals/errors, deduplicates, and respects concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  const mockAnswer = async ({ question, scope }) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;

    if (question.includes('World Cup')) {
      return { question, scope, refused: true, grounded: false, answer: 'Refused', citations: [], sources: [] };
    }
    if (question.includes('BOOM')) {
      throw Object.assign(new Error('Simulated failure'), { status: 503 });
    }
    return {
      question,
      scope,
      refused: false,
      grounded: true,
      answer: `Answer for ${question}`,
      citations: [{ citation: '[WHO, p. 9]' }],
      sources: [],
    };
  };

  const batch = await answerBatch(
    {
      questions: [
        '1. What is dietary adequacy?',
        '2. Who won the 2018 football World Cup?',
        '3. What is dietary adequacy?', // duplicate!
        '4. BOOM error test',
        '5. Why is food safety essential?',
      ],
      scope: 'builtin',
      concurrency: 2,
    },
    { answerQuestion: mockAnswer }
  );

  assert.equal(batch.total, 5);
  assert.equal(batch.answered, 3);
  assert.equal(batch.refused, 1);
  assert.equal(batch.failed, 1);
  assert.equal(batch.deduplicated, 1);
  assert.equal(calls, 4); // duplicate was not re-executed
  assert.ok(maxActive <= 2);

  // Exact input order preserved
  assert.deepEqual(
    batch.results.map((r) => [r.index, r.question]),
    [
      [1, 'What is dietary adequacy?'],
      [2, 'Who won the 2018 football World Cup?'],
      [3, 'What is dietary adequacy?'],
      [4, 'BOOM error test'],
      [5, 'Why is food safety essential?'],
    ]
  );
  assert.equal(batch.results[1].refused, true);
  assert.equal(batch.results[2].deduplicated, true);
  assert.equal(batch.results[3].error, 'Simulated failure');
  assert.equal(batch.results[4].grounded, true);
});

/* ------------------ 4. Model Config ------------------ */

test('Groq model configuration defaults to openai/gpt-oss-120b', () => {
  assert.equal(config.groq.model, 'openai/gpt-oss-120b');
});
