import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.join(__dirname, '..', 'evaluation', 'dataset.json');

test('RAG evaluation dataset has 30 well-formed questions with exact category balance', () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  assert.equal(dataset.questions.length, 30);

  const counts = {};
  const seenIds = new Set();
  for (const q of dataset.questions) {
    assert.ok(q.id && !seenIds.has(q.id), `Duplicate or missing ID: ${q.id}`);
    seenIds.add(q.id);
    assert.ok(typeof q.question === 'string' && q.question.length > 5);
    assert.ok(typeof q.answerable === 'boolean');
    assert.ok(['answer', 'refuse', 'correct_premise'].includes(q.expectedBehavior));
    assert.ok(Array.isArray(q.expectedPages));
    for (const p of q.expectedPages) {
      assert.ok(Number.isInteger(p) && p >= 1 && p <= dataset.sourceDocument.totalPdfPages);
    }
    if (q.category === 'follow_up') {
      assert.ok(Array.isArray(q.conversationHistory) && q.conversationHistory.length >= 2);
    }
    if (!q.answerable) {
      assert.equal(q.expectedBehavior, 'refuse');
      assert.equal(q.expectedPages.length, 0);
    }
    counts[q.category] = (counts[q.category] || 0) + 1;
  }

  assert.deepEqual(counts, {
    direct_factual: 8,
    multi_passage: 5,
    reasoning: 5,
    follow_up: 4,
    unsupported_healthcare: 5,
    misleading_premise: 3,
  });
});

