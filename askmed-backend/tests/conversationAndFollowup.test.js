import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion } from '../services/ragService.js';
import {
  _resetAllSessions,
  appendTurn,
  clearSession,
  createSessionId,
  getHistory,
  isValidSessionId,
} from '../services/sessionStore.js';

function createConversationMocks({ routerDecision, chatAnswer = '', ragAnswer = '', results = [] }) {
  const trace = { retrieveQueries: [], chatMessages: [], ragMessages: [], routerCalls: 0 };

  const retrieve = async (query) => {
    trace.retrieveQueries.push(query);
    return { results, stats: { namespacesSearched: ['builtin'], candidatePool: results.length } };
  };

  const groq = {
    chat: {
      completions: {
        create: async (params) => {
          if (params.response_format?.type === 'json_object') {
            trace.routerCalls += 1;
            return {
              choices: [{ message: { content: JSON.stringify(routerDecision) } }],
              usage: { prompt_tokens: 90, completion_tokens: 20 },
            };
          }
          // Distinguish conversational generation vs RAG generation by system prompt
          const sys = params.messages[0]?.content || '';
          if (sys.includes('STRICT DOCUMENT-GROUNDING RULES')) {
            trace.ragMessages.push(params.messages);
            return {
              choices: [{ message: { content: ragAnswer } }],
              usage: { prompt_tokens: 200, completion_tokens: 60 },
            };
          }
          trace.chatMessages.push(params.messages);
          return {
            choices: [{ message: { content: chatAnswer } }],
            usage: { prompt_tokens: 120, completion_tokens: 45 },
          };
        },
      },
    },
  };

  return { trace, deps: { retrieve, groq } };
}

test('natural greetings use conversational LLM generation without hitting Pinecone', async () => {
  const { trace, deps } = createConversationMocks({
    routerDecision: { route: 'chat', intent: 'greeting' },
    chatAnswer: "Hey! I'm AskMed, your AI assistant for understanding and exploring documents. What's on your mind?",
  });

  const res = await answerQuestion({ question: 'hey there!', scope: 'builtin' }, deps);

  assert.equal(trace.routerCalls, 1);
  assert.equal(trace.retrieveQueries.length, 0);
  assert.equal(trace.chatMessages.length, 1);
  assert.equal(res.mode, 'chat');
  assert.equal(res.conversational, true);
  assert.equal(res.intent, 'greeting');
  assert.equal(res.retrieval.skipped, true);
  assert.match(res.answer, /AskMed/);
});

test('capability questions skip retrieval and pass history', async () => {
  const history = [
    { role: 'user', content: 'Hi, my name is Anjan.' },
    { role: 'assistant', content: 'Nice to meet you, Anjan! How can I help?' },
  ];
  const { trace, deps } = createConversationMocks({
    routerDecision: { route: 'chat', intent: 'capability' },
    chatAnswer: 'Hi Anjan — I am AskMed, your AI assistant for understanding and exploring documents.',
  });

  const res = await answerQuestion(
    { question: 'What can you help me with?', scope: 'builtin', history },
    deps
  );

  assert.equal(trace.retrieveQueries.length, 0);
  assert.equal(trace.chatMessages.length, 1);
  // History was included in conversational LLM prompt
  assert.ok(trace.chatMessages[0].some((m) => m.content.includes('my name is Anjan')));
  assert.equal(res.mode, 'chat');
  assert.equal(res.intent, 'capability');
  assert.equal(res.refused, false);
});

test('follow-up document question rewrites standalone query using history and returns grounded answer', async () => {
  const history = [
    { role: 'user', content: 'What are the four core principles of healthy diets?' },
    {
      role: 'assistant',
      content: 'The four principles are adequate, balanced, moderate, and diverse [WHO-FAO Healthy Diets Report, p. 9].',
    },
  ];
  const passage = {
    rank: 1,
    id: 'builtin-who#p10#c0',
    namespace: 'builtin',
    title: 'WHO-FAO Healthy Diets Report',
    source: 'who_healthy_diets.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 10,
    citation: '[WHO-FAO Healthy Diets Report, p. 10]',
    scores: { rerank: 0.88, dense: 0.62, lexical: 4.1 },
    text: 'An adequate diet meets, without exceeding, nutrient requirements specific for age, gender, and life stage.',
  };

  const { trace, deps } = createConversationMocks({
    routerDecision: {
      route: 'rag',
      intent: 'follow_up',
      standaloneQuery: 'What does dietary adequacy mean and why is it important?',
    },
    results: [passage],
    ragAnswer:
      'In simple terms, an adequate diet gives your body enough essential nutrients for your age and needs without going overboard [WHO-FAO Healthy Diets Report, p. 10].',
  });

  const res = await answerQuestion(
    { question: 'Explain the first one simply.', scope: 'builtin', history },
    deps
  );

  assert.equal(trace.retrieveQueries.length, 1);
  assert.equal(trace.retrieveQueries[0], 'What does dietary adequacy mean and why is it important?');
  assert.equal(trace.ragMessages.length, 1);
  assert.ok(trace.ragMessages[0].some((m) => m.content.includes('four core principles')));
  assert.equal(res.mode, 'rag');
  assert.equal(res.intent, 'follow_up');
  assert.equal(res.grounded, true);
  assert.equal(res.retrieval.rewrittenQuery, 'What does dietary adequacy mean and why is it important?');
  assert.equal(res.citations[0].citation, '[WHO-FAO Healthy Diets Report, p. 10]');
});

test('unsupported document-specific question routes to RAG and refuses cleanly', async () => {
  const lowHit = {
    rank: 1,
    id: 'builtin-who#p4#c0',
    namespace: 'builtin',
    title: 'WHO-FAO Healthy Diets Report',
    source: 'who_healthy_diets.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 4,
    citation: '[WHO-FAO Healthy Diets Report, p. 4]',
    scores: { rerank: 0.0004, dense: 0.08, lexical: 0.5 },
    text: 'Joint statement by FAO and WHO.',
  };
  const { trace, deps } = createConversationMocks({
    routerDecision: { route: 'rag', intent: 'document_query', standaloneQuery: '' },
    results: [lowHit],
  });

  const res = await answerQuestion(
    { question: 'What does the report say about quantum computing?', scope: 'builtin' },
    deps
  );

  assert.equal(trace.retrieveQueries.length, 1);
  assert.equal(trace.ragMessages.length, 0);
  assert.equal(res.mode, 'rag');
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'LOW_RELEVANCE');
  assert.equal(res.grounded, false);
});

test('sessionStore isolates conversations by sessionId and supports clearing', () => {
  _resetAllSessions();
  const s1 = createSessionId();
  const s2 = createSessionId();
  assert.ok(isValidSessionId(s1));
  assert.equal(isValidSessionId('bad id!'), false);

  appendTurn(s1, 'Hello from user 1', 'Hi user 1!');
  appendTurn(s2, 'Hello from user 2', 'Hi user 2!');

  assert.equal(getHistory(s1).length, 2);
  assert.equal(getHistory(s1)[0].content, 'Hello from user 1');
  assert.equal(getHistory(s2)[0].content, 'Hello from user 2');

  assert.equal(clearSession(s1), true);
  assert.deepEqual(getHistory(s1), []);
  assert.equal(getHistory(s2).length, 2);
});

