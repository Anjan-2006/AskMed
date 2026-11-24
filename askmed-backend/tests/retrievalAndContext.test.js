import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, isExplicitDocumentQuery, selectRelevantPassages } from '../services/ragService.js';

function makePassage({ id, page, title = 'Sample Report', rerank, dense = 0.5, lexical = 3.5, text }) {
  return {
    rank: 1,
    id,
    namespace: 'builtin',
    title,
    source: 'sample.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page,
    citation: `[${title}, p. ${page}]`,
    scores: { rerank, dense, lexical },
    text,
  };
}

function makeGroqMock({ routerDecision, ragAnswer = '', chatAnswer = '' }) {
  const seen = { routerUserPrompt: '', ragUserPrompt: '' };
  const groq = {
    chat: {
      completions: {
        create: async (params) => {
          if (params.response_format?.type === 'json_object') {
            seen.routerUserPrompt = params.messages[1]?.content || '';
            return {
              choices: [{ message: { content: JSON.stringify(routerDecision) } }],
              usage: { prompt_tokens: 100, completion_tokens: 40 },
            };
          }
          const sys = params.messages[0]?.content || '';
          if (sys.includes('STRICT DOCUMENT-GROUNDING RULES')) {
            seen.ragUserPrompt = params.messages[params.messages.length - 1]?.content || '';
            return {
              choices: [{ message: { content: ragAnswer } }],
              usage: { prompt_tokens: 200, completion_tokens: 80 },
            };
          }
          return {
            choices: [{ message: { content: chatAnswer } }],
            usage: { prompt_tokens: 100, completion_tokens: 40 },
          };
        },
      },
    },
  };
  return { groq, seen };
}

test('comparison question retrieves evidence for EACH concept and combines citations', async () => {
  const queries = [];
  const pConceptA = makePassage({
    id: 'doc#p9#c0',
    page: 9,
    rerank: 0.47,
    text: 'Concept A ensures appropriate energy intake and macronutrient proportions.',
  });
  const pConceptB = makePassage({
    id: 'doc#p10#c0',
    page: 10,
    rerank: 0.92,
    text: 'Concept B meets, without exceeding, essential nutrient requirements.',
  });

  const retrieve = async (q) => {
    queries.push(q);
    if (/concept a/i.test(q)) return { results: [pConceptA], stats: {} };
    if (/concept b/i.test(q)) return { results: [pConceptB], stats: {} };
    return { results: [], stats: {} };
  };

  const { groq } = makeGroqMock({
    routerDecision: {
      route: 'rag',
      intent: 'document_query',
      queryType: 'comparison',
      subQueries: ['definition of Concept A', 'definition of Concept B'],
    },
    ragAnswer:
      'Concept A focuses on macronutrient balance [Sample Report, p. 9], whereas Concept B focuses on meeting essential nutrient requirements without excess [Sample Report, p. 10].',
  });

  const res = await answerQuestion(
    { question: 'How is Concept A different from Concept B?', scope: 'builtin' },
    { retrieve, groq }
  );

  assert.equal(queries.length, 2);
  assert.equal(res.refused, false);
  assert.equal(res.grounded, true);
  assert.equal(res.retrieval.queryType, 'comparison');
  assert.equal(res.retrieval.accepted, 2);
  assert.equal(res.citations.length, 2);
});

test('comparison question refuses if one side genuinely has no supporting evidence', async () => {
  const pConceptA = makePassage({
    id: 'doc#p9#c0',
    page: 9,
    rerank: 0.62,
    text: 'Concept A is clearly defined here.',
  });
  const weakOther = makePassage({
    id: 'doc#p4#c0',
    page: 4,
    rerank: 0.001,
    dense: 0.08,
    lexical: 0.2,
    text: 'Unrelated front matter.',
  });

  const retrieve = async (q) => ({
    results: /concept a/i.test(q) ? [pConceptA] : [weakOther],
    stats: {},
  });

  const { groq } = makeGroqMock({
    routerDecision: {
      route: 'rag',
      intent: 'document_query',
      queryType: 'comparison',
      subQueries: ['definition of Concept A', 'definition of Missing Concept'],
    },
    ragAnswer: 'Should never be called',
  });

  const res = await answerQuestion(
    { question: 'How is Concept A different from Missing Concept?', scope: 'builtin' },
    { retrieve, groq }
  );

  assert.equal(res.refused, true);
  assert.equal(res.grounded, false);
  assert.equal(res.reason, 'INCOMPLETE_COMPARISON_EVIDENCE');
  assert.deepEqual(res.retrieval.missingConcepts, ['definition of Missing Concept']);
});

test('broad summary question expands into multiple sub-queries and merges diverse sections', async () => {
  const queries = [];
  const p1 = makePassage({ id: 'doc#p9#c0', page: 9, rerank: 0.22, text: 'Core principles overview.' });
  const p2 = makePassage({ id: 'doc#p20#c0', page: 20, rerank: 0.19, text: 'Key recommendations on intake.' });
  const p3 = makePassage({ id: 'doc#p15#c0', page: 15, rerank: 0.17, text: 'Food-based dietary guidelines.' });

  const retrieve = async (q) => {
    queries.push(q);
    if (queries.length === 1) return { results: [p1], stats: {} };
    if (queries.length === 2) return { results: [p2], stats: {} };
    return { results: [p3], stats: {} };
  };

  const { groq } = makeGroqMock({
    routerDecision: {
      route: 'rag',
      intent: 'document_query',
      queryType: 'summary',
      subQueries: ['core principles overview', 'main recommendations', 'dietary guidelines'],
    },
    ragAnswer:
      '- Core principles [Sample Report, p. 9]\n- Key recommendations [Sample Report, p. 20]\n- Guidelines [Sample Report, p. 15]',
  });

  const res = await answerQuestion(
    { question: "Can you summarize the report's main recommendations in five bullet points?", scope: 'builtin' },
    { retrieve, groq }
  );

  assert.equal(queries.length, 3);
  assert.equal(res.refused, false);
  assert.equal(res.grounded, true);
  assert.equal(res.retrieval.queryType, 'summary');
  assert.equal(res.retrieval.accepted, 3);
  assert.equal(res.retrieval.passedThreshold, 3);
  assert.equal(res.citations.length, 3);
});

test('retrieval metadata distinguishes passedThreshold from hybrid-corroborated accepted passages', async () => {
  const unacceptedTop = makePassage({
    id: 'doc#p14#c0',
    page: 14,
    rerank: 0.1371,
    dense: 0.31,
    lexical: 1.5,
    text: 'Weakly related chunk.',
  });
  const corroborated = makePassage({
    id: 'doc#p9#c0',
    page: 9,
    rerank: 0.0749,
    dense: 0.48,
    lexical: 3.4,
    text: 'Relevant chunk corroborated by dense + lexical.',
  });

  const gate = selectRelevantPassages([unacceptedTop, corroborated], 0.15);
  assert.equal(gate.gateMode, 'hybrid-corroborated');
  assert.equal(gate.passedThresholdCount, 0);
  assert.equal(gate.passages.length, 1);
  assert.equal(gate.passages[0].acceptedBy, 'hybrid-corroborated');

  const { groq } = makeGroqMock({
    routerDecision: { route: 'rag', intent: 'document_query', queryType: 'standard' },
    ragAnswer: 'Answer grounded in corroborated chunk [Sample Report, p. 9].',
  });

  const res = await answerQuestion(
    { question: 'Which principle relates to eating a variety of foods?', scope: 'builtin' },
    { retrieve: async () => ({ results: [unacceptedTop, corroborated], stats: {} }), groq }
  );

  // Metadata is now 100% consistent: 0 passed 0.15 threshold, 1 accepted via hybrid-corroborated
  assert.equal(res.retrieval.passedThreshold, 0);
  assert.equal(res.retrieval.accepted, 1);
  assert.equal(res.retrieval.gateMode, 'hybrid-corroborated');
  assert.equal(res.retrieval.topScore, 0.1371);
  assert.equal(res.retrieval.acceptedTopScore, 0.0749);
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].acceptedBy, 'hybrid-corroborated');
  assert.equal(res.grounded, true);
});

test('ordinal follow-up ("second principle") resolves against earlier enumerated list, not most recent message', async () => {
  const history = [
    { role: 'user', content: 'What are the four core principles?' },
    { role: 'assistant', content: '1. Principle One\n2. Principle Two\n3. Principle Three\n4. Principle Four [Sample Report, p. 9]' },
    { role: 'user', content: 'Which one relates to variety?' },
    { role: 'assistant', content: 'Principle Four relates to variety [Sample Report, p. 9].' },
  ];

  const pTwo = makePassage({
    id: 'doc#p11#c0',
    page: 11,
    rerank: 0.85,
    text: 'Principle Two means maintaining an appropriate balance of components.',
  });

  const retrievedQueries = [];
  const { groq, seen } = makeGroqMock({
    routerDecision: {
      route: 'rag',
      intent: 'follow_up',
      queryType: 'standard',
      standaloneQuery: 'Explain Principle Two and give an example',
      resolvedReference: 'Principle Two (2nd item in the earlier 4-principle list)',
    },
    ragAnswer: 'Principle Two means maintaining an appropriate balance [Sample Report, p. 11].',
  });

  const res = await answerQuestion(
    {
      question: 'Explain the second principle you mentioned earlier, and give me a simple example.',
      scope: 'builtin',
      history,
    },
    {
      retrieve: async (q) => {
        retrievedQueries.push(q);
        return { results: [pTwo], stats: {} };
      },
      groq,
    }
  );

  assert.ok(seen.routerUserPrompt.includes('1. Principle One'));
  assert.equal(retrievedQueries[0], 'Explain Principle Two and give an example');
  assert.ok(seen.ragUserPrompt.includes('RESOLVED CONTEXT REFERENCE: Principle Two'));
  assert.ok(seen.ragUserPrompt.includes('QUESTION: Explain the second principle you mentioned earlier'));
  assert.equal(res.grounded, true);
  assert.equal(res.retrieval.resolvedReference, 'Principle Two (2nd item in the earlier 4-principle list)');
});

test('unsupported question still refuses safely and general chat still skips retrieval', async () => {
  const weakHit = makePassage({ id: 'doc#p4#c0', page: 4, rerank: 0.0002, dense: 0.07, lexical: 0.3, text: 'Copyright.' });
  const { groq: groqRefuse } = makeGroqMock({
    routerDecision: { route: 'rag', intent: 'document_query', queryType: 'standard' },
  });
  const refused = await answerQuestion(
    { question: 'What does the report say about Mars colonization?', scope: 'builtin' },
    { retrieve: async () => ({ results: [weakHit], stats: {} }), groq: groqRefuse }
  );
  assert.equal(refused.refused, true);
  assert.equal(refused.grounded, false);
  assert.equal(refused.retrieval.accepted, 0);

  let retrieveCalled = 0;
  const { groq: groqChat } = makeGroqMock({
    routerDecision: { route: 'chat', intent: 'greeting' },
    chatAnswer: 'Hey! How can I help you today?',
  });
  const chat = await answerQuestion(
    { question: 'Hey there!', scope: 'builtin' },
    {
      retrieve: async () => {
        retrieveCalled += 1;
        return { results: [], stats: {} };
      },
      groq: groqChat,
    }
  );
  assert.equal(retrieveCalled, 0);
  assert.equal(chat.mode, 'chat');
  assert.equal(chat.retrieval.skipped, true);
});

test('explicit document-based unsupported comparison stays in RAG even if router suggests chat', async () => {
  assert.equal(isExplicitDocumentQuery('According to the report, how is X different from Y?'), true);
  assert.equal(isExplicitDocumentQuery('Explain how photosynthesis works.'), false);

  const pA = makePassage({ id: 'doc#p9#c0', page: 9, rerank: 0.65, text: 'X is clearly defined.' });
  const weakB = makePassage({ id: 'doc#p4#c0', page: 4, rerank: 0.001, dense: 0.06, lexical: 0.1, text: 'Cover.' });

  const retrieve = async (q) => ({ results: /concept x/i.test(q) ? [pA] : [weakB], stats: {} });
  const { groq } = makeGroqMock({
    routerDecision: {
      route: 'chat', // intentionally wrong router output — explicit doc guard must keep it in RAG!
      intent: 'general_chat',
      queryType: 'comparison',
      subQueries: ['definition of Concept X', 'definition of Missing Topic'],
    },
    chatAnswer: 'Should not be used',
  });

  const res = await answerQuestion(
    { question: 'According to the report, how is Concept X different from Missing Topic?', scope: 'builtin' },
    { retrieve, groq }
  );

  assert.equal(res.mode, 'rag');
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'INCOMPLETE_COMPARISON_EVIDENCE');
  assert.equal(res.grounded, false);
});

test('citation revision pass adds valid inline citations when first draft omits them', async () => {
  const pA = makePassage({ id: 'doc#p9#c0', page: 9, rerank: 0.55, text: 'Concept A defines energy balance.' });
  const pB = makePassage({ id: 'doc#p10#c0', page: 10, rerank: 0.88, text: 'Concept B defines nutrient adequacy.' });

  let ragGenCalls = 0;
  const groq = {
    chat: {
      completions: {
        create: async (params) => {
          if (params.response_format?.type === 'json_object') {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      route: 'rag',
                      intent: 'document_query',
                      queryType: 'comparison',
                      subQueries: ['Concept A', 'Concept B'],
                    }),
                  },
                },
              ],
            };
          }
          ragGenCalls += 1;
          return {
            choices: [
              {
                message: {
                  content:
                    ragGenCalls === 1
                      ? 'Concept A is about energy balance, whereas Concept B is about nutrient adequacy.' // no citations!
                      : 'Concept A is about energy balance [Sample Report, p. 9], whereas Concept B is about nutrient adequacy [Sample Report, p. 10].',
                },
              },
            ],
          };
        },
      },
    },
  };

  const res = await answerQuestion(
    { question: 'How is Concept A different from Concept B?', scope: 'builtin' },
    {
      retrieve: async (q) => ({ results: /concept a/i.test(q) ? [pA] : [pB], stats: {} }),
      groq,
    }
  );

  assert.equal(ragGenCalls, 2);
  assert.equal(res.grounded, true);
  assert.equal(res.warnings.length, 0);
  assert.equal(res.citations.length, 2);
});

