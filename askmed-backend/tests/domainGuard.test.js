import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, OUT_OF_DOMAIN_MESSAGE } from '../services/ragService.js';
import { answerWithWebSearch } from '../services/webSearchService.js';

function makeRouterGroq(routerDecision, answerText = '') {
  return {
    chat: {
      completions: {
        create: async (params) => ({
          choices: [
            {
              message: {
                content:
                  params.response_format?.type === 'json_object'
                    ? JSON.stringify(routerDecision)
                    : answerText,
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 30 },
        }),
      },
    },
  };
}

test('unrelated AI question is rejected immediately with zero Pinecone and zero Tavily calls and no web-search consent', async () => {
  let retrieveCalls = 0;
  let tavilyCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('tavily.com')) tavilyCalls += 1;
    return origFetch(url, ...rest);
  };

  try {
    const groq = makeRouterGroq({ route: 'out_of_domain', intent: 'out_of_domain' });
    const res = await answerQuestion(
      { question: 'What were the biggest AI breakthroughs of 2025?', scope: 'both' },
      {
        retrieve: async () => {
          retrieveCalls += 1;
          return { results: [], stats: {} };
        },
        groq,
      }
    );

    assert.equal(retrieveCalls, 0);
    assert.equal(tavilyCalls, 0);
    assert.equal(res.mode, 'guard');
    assert.equal(res.refused, true);
    assert.equal(res.canSearchWeb, false);
    assert.equal(res.grounded, false);
    assert.equal(res.reason, 'OUT_OF_DOMAIN');
    assert.equal(res.answer, OUT_OF_DOMAIN_MESSAGE);
    assert.equal(res.retrieval.skipped, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('explicitly requesting web search for an unrelated question does NOT bypass domain guard and makes zero Tavily calls', async () => {
  let tavilyCalls = 0;
  const groq = makeRouterGroq({ route: 'out_of_domain', intent: 'out_of_domain' });

  const res = await answerWithWebSearch(
    { question: 'What were the biggest AI breakthroughs of 2025?' },
    {
      groq,
      searchTavily: async () => {
        tavilyCalls += 1;
        return [{ title: 'Should never be called', url: 'https://example.com', domain: 'example.com', content: 'x' }];
      },
    }
  );

  assert.equal(tavilyCalls, 0);
  assert.equal(res.mode, 'guard');
  assert.equal(res.refused, true);
  assert.equal(res.canSearchWeb, false);
  assert.equal(res.answer, OUT_OF_DOMAIN_MESSAGE);
  assert.deepEqual(res.webSources, []);
});

test('healthcare question absent from documents still refuses naturally with canSearchWeb=true and can use web search after consent', async () => {
  const lowHit = {
    rank: 1,
    id: 'doc#p4#c0',
    namespace: 'builtin',
    title: 'WHO-FAO Healthy Diets Report',
    source: 'who.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 4,
    citation: '[WHO-FAO Healthy Diets Report, p. 4]',
    scores: { rerank: 0.004, dense: 0.12, lexical: 0.2 },
    text: 'Healthy diets report cover.',
  };

  const groqRag = makeRouterGroq({ route: 'rag', intent: 'document_query', queryType: 'standard' });
  const initial = await answerQuestion(
    { question: 'What are the early symptoms of Lyme disease?', scope: 'both' },
    { retrieve: async () => ({ results: [lowHit], stats: {} }), groq: groqRag }
  );

  assert.equal(initial.mode, 'rag');
  assert.equal(initial.refused, true);
  assert.equal(initial.canSearchWeb, true);
  assert.match(initial.answer, /search the web/i);

  // After explicit user consent -> web search runs for this healthcare question
  let tavilyCalls = 0;
  const groqWeb = makeRouterGroq(
    { route: 'rag', intent: 'document_query' },
    'Early symptoms of Lyme disease often include fever, headache, fatigue, and a bullseye rash.'
  );
  const webRes = await answerWithWebSearch(
    { question: 'What are the early symptoms of Lyme disease?' },
    {
      groq: groqWeb,
      searchTavily: async () => {
        tavilyCalls += 1;
        return [
          {
            title: 'CDC Lyme Disease Symptoms',
            url: 'https://www.cdc.gov/lyme/signs-symptoms/index.html',
            domain: 'cdc.gov',
            content: 'Early signs include fever, headache, fatigue, and erythema migrans rash.',
          },
        ];
      },
    }
  );

  assert.equal(tavilyCalls, 1);
  assert.equal(webRes.mode, 'web');
  assert.equal(webRes.sourceType, 'web');
  assert.equal(webRes.refused, false);
  assert.equal(webRes.webSources.length, 1);
  assert.equal(webRes.webSources[0].domain, 'cdc.gov');
});

test('greetings and healthcare RAG questions continue working normally', async () => {
  const groqGreeting = makeRouterGroq(
    { route: 'chat', intent: 'greeting' },
    "Hello! I'm AskMed, your healthcare information assistant."
  );
  const gRes = await answerQuestion({ question: 'hello', scope: 'both' }, { groq: groqGreeting });
  assert.equal(gRes.mode, 'chat');
  assert.equal(gRes.refused, false);
  assert.equal(gRes.retrieval.skipped, true);

  const passage = {
    rank: 1,
    id: 'builtin-who#p9#c0',
    namespace: 'builtin',
    title: 'WHO-FAO Healthy Diets Report',
    source: 'who.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 9,
    citation: '[WHO-FAO Healthy Diets Report, p. 9]',
    scores: { rerank: 0.95, dense: 0.72, lexical: 5.1 },
    text: 'Healthy diets meet four core principles: adequate, balanced, moderate, and diverse.',
  };
  const groqDoc = makeRouterGroq(
    { route: 'rag', intent: 'document_query', queryType: 'standard' },
    'Healthy diets are adequate, balanced, moderate, and diverse [WHO-FAO Healthy Diets Report, p. 9].'
  );
  const dRes = await answerQuestion(
    { question: 'What are the four core principles of healthy diets?', scope: 'both' },
    { retrieve: async () => ({ results: [passage], stats: {} }), groq: groqDoc }
  );
  assert.equal(dRes.mode, 'rag');
  assert.equal(dRes.grounded, true);
  assert.equal(dRes.citations[0].citation, '[WHO-FAO Healthy Diets Report, p. 9]');
});

