import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, routeConversation } from '../services/ragService.js';

function createMocks({ routerReply = { route: 'rag' }, results = [], llmAnswer = '' } = {}) {
  const calls = { retrieve: 0, router: 0, ragGenerate: 0 };
  const retrieve = async () => {
    calls.retrieve += 1;
    return { results, stats: { namespacesSearched: ['builtin'], candidatePool: results.length } };
  };
  const groq = {
    chat: {
      completions: {
        create: async (params) => {
          if (params.response_format?.type === 'json_object') {
            calls.router += 1;
            return {
              choices: [{ message: { content: JSON.stringify(routerReply) } }],
              usage: { prompt_tokens: 80, completion_tokens: 25 },
            };
          }
          calls.ragGenerate += 1;
          return {
            choices: [{ message: { content: llmAnswer } }],
            usage: { prompt_tokens: 100, completion_tokens: 40 },
          };
        },
      },
    },
  };
  return { calls, deps: { retrieve, groq } };
}

test('"hi" / "hii" returns LLM greeting without retrieval', async () => {
  const { calls, deps } = createMocks({
    routerReply: {
      route: 'chat',
      intent: 'greeting',
      reply: "Hey! I'm AskMed, your healthcare document assistant. Ask me any health question!",
    },
  });
  const res = await answerQuestion({ question: 'hii', scope: 'builtin' }, deps);

  assert.equal(calls.router, 1);
  assert.equal(calls.retrieve, 0);
  assert.equal(calls.ragGenerate, 0);
  assert.equal(res.conversational, true);
  assert.equal(res.intent, 'greeting');
  assert.equal(res.refused, false);
  assert.equal(res.retrieval.skipped, true);
  assert.match(res.answer, /AskMed/i);
  assert.ok(res.disclaimer);
});

test('"thanks" returns LLM conversational response without retrieval', async () => {
  const { calls, deps } = createMocks({
    routerReply: {
      route: 'chat',
      intent: 'thanks',
      reply: "You're welcome! Let me know if you have any more health questions.",
    },
  });
  const res = await answerQuestion({ question: 'thanks', scope: 'builtin' }, deps);

  assert.equal(calls.router, 1);
  assert.equal(calls.retrieve, 0);
  assert.equal(res.conversational, true);
  assert.equal(res.intent, 'thanks');
  assert.equal(res.refused, false);
  assert.equal(res.retrieval.skipped, true);
});

test('"What can you help me with?" explains AskMed capabilities without retrieval', async () => {
  const { calls, deps } = createMocks({
    routerReply: {
      route: 'chat',
      intent: 'capability',
      reply: 'I am AskMed, a healthcare document assistant that searches public health and personal PDFs with page citations.',
    },
  });
  const res = await answerQuestion({ question: 'What can you help me with?', scope: 'builtin' }, deps);

  assert.equal(calls.router, 1);
  assert.equal(calls.retrieve, 0);
  assert.equal(res.conversational, true);
  assert.equal(res.intent, 'capability');
  assert.equal(res.refused, false);
  assert.equal(res.retrieval.skipped, true);
});

test('"What are the four principles of healthy diets?" routes to full RAG pipeline', async () => {
  const passage = {
    rank: 1,
    id: 'builtin-who-healthy-diets#p1#c0',
    namespace: 'builtin',
    title: 'WHO Healthy Diets',
    source: 'who_healthy_diets.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 1,
    citation: '[WHO Healthy Diets, p. 1]',
    scores: { rerank: 0.92, dense: 0.78, lexical: 0.65, hybridRrf: 0.016, denseRank: 1, lexicalRank: 1 },
    text: 'The four principles of a healthy diet are adequacy, balance, moderation, and diversity.',
  };
  const { calls, deps } = createMocks({
    routerReply: { route: 'rag' },
    results: [passage],
    llmAnswer:
      'The four principles of a healthy diet are adequacy, balance, moderation, and diversity. [WHO Healthy Diets, p. 1]',
  });

  const res = await answerQuestion(
    { question: 'What are the four principles of healthy diets?', scope: 'builtin' },
    deps
  );

  assert.equal(calls.router, 1);
  assert.equal(calls.retrieve, 1);
  assert.equal(calls.ragGenerate, 1);
  assert.equal(res.conversational, undefined);
  assert.equal(res.refused, false);
  assert.equal(res.grounded, true);
  assert.equal(res.citations[0].citation, '[WHO Healthy Diets, p. 1]');
});

test('"Who won the 2018 football World Cup?" routes to RAG and triggers existing refusal', async () => {
  const lowScoreHit = {
    rank: 1,
    id: 'builtin-who-healthy-diets#p1#c0',
    namespace: 'builtin',
    title: 'WHO Healthy Diets',
    source: 'who_healthy_diets.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 1,
    citation: '[WHO Healthy Diets, p. 1]',
    scores: { rerank: 0.01, dense: 0.05, lexical: 0, hybridRrf: 0.01, denseRank: 1, lexicalRank: null },
    text: 'Healthy diets help protect against malnutrition.',
  };
  const { calls, deps } = createMocks({ routerReply: { route: 'rag' }, results: [lowScoreHit] });

  const res = await answerQuestion(
    { question: 'Who won the 2018 football World Cup?', scope: 'builtin' },
    deps
  );

  assert.equal(calls.router, 1);
  assert.equal(calls.retrieve, 1);
  assert.equal(calls.ragGenerate, 0);
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'LOW_RELEVANCE');
  assert.equal(res.grounded, false);
});

test('emergency red-flag messages bypass conversational router completely', async () => {
  const { calls, deps } = createMocks({
    routerReply: { route: 'chat', intent: 'greeting', reply: 'Hi!' },
  });
  const routed = await routeConversation('hi I have chest pain', 'builtin', deps.groq);
  assert.equal(routed.route, 'rag');
  assert.equal(calls.router, 0);
});
