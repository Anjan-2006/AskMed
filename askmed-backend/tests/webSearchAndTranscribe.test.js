import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion } from '../services/ragService.js';
import { answerWithWebSearch, isTavilyConfigured, searchTavily } from '../services/webSearchService.js';
import { transcribeAudio } from '../services/transcribeService.js';

test('user-facing refusal hides relevance scores, thresholds, and backend diagnostics', async () => {
  const lowHit = {
    rank: 1,
    id: 'builtin-who#p4#c0',
    namespace: 'builtin',
    title: 'WHO-FAO Healthy Diets Report',
    source: 'who.pdf',
    publisher: 'WHO',
    sourceUrl: '',
    page: 4,
    citation: '[WHO-FAO Healthy Diets Report, p. 4]',
    scores: { rerank: 0.0212, dense: 0.08, lexical: 0.5 },
    text: 'Copyright page.',
  };

  const groq = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({ route: 'rag', intent: 'document_query', queryType: 'standard' }) } }],
        }),
      },
    },
  };

  const res = await answerQuestion(
    { question: 'What does the report say about Mars colonies?', scope: 'builtin' },
    { retrieve: async () => ({ results: [lowHit], stats: {} }), groq }
  );

  assert.equal(res.refused, true);
  assert.equal(res.canSearchWeb, true);
  assert.doesNotMatch(res.answer, /0\.0212|0\.15|threshold|best relevance|knowledge base/i);
  assert.match(res.answer, /search the web/i);
});

test('Tavily missing-key fallback throws a friendly 503 error without crashing', async () => {
  assert.equal(isTavilyConfigured(''), false);
  assert.equal(isTavilyConfigured('your_tavily_api_key_here'), false);
  assert.equal(isTavilyConfigured('tvly-real-looking-key-12345'), true);

  await assert.rejects(
    () => searchTavily('healthy diets', { apiKey: 'your_tavily_api_key_here' }),
    (err) => err.status === 503 && /TAVILY_API_KEY/i.test(err.message)
  );
});

test('answerWithWebSearch grounds answer in Tavily results and returns clean clickable sources', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        {
          title: 'WHO Healthy Diet Fact Sheet',
          url: 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet',
          content: 'A healthy diet helps protect against malnutrition and noncommunicable diseases.',
          score: 0.9876,
        },
        {
          title: 'Duplicate URL should be ignored',
          url: 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet',
          content: 'Duplicate.',
          score: 0.5,
        },
      ],
    }),
  });

  const groq = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: 'Based on web sources, a healthy diet helps protect against malnutrition and chronic diseases.',
              },
            },
          ],
        }),
      },
    },
  };

  const res = await answerWithWebSearch(
    { question: 'Why is a healthy diet important?' },
    {
      routeConversation: async () => ({ route: 'rag', intent: 'document_query' }),
      searchTavily: (q) => searchTavily(q, { apiKey: 'tvly-test-key-123456' }, { fetch: mockFetch }),
      groq,
    }
  );

  assert.equal(res.mode, 'web');
  assert.equal(res.sourceType, 'web');
  assert.equal(res.refused, false);
  assert.equal(res.webSources.length, 1);
  assert.deepEqual(res.webSources[0], {
    title: 'WHO Healthy Diet Fact Sheet',
    url: 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet',
    domain: 'who.int',
  });
  // Ensure Tavily internal score is never leaked
  assert.equal('score' in res.webSources[0], false);
});

test('initial /api/chat unsupported question refuses with canSearchWeb=true and makes ZERO Tavily calls', async () => {
  let tavilyCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('tavily.com')) tavilyCalls += 1;
    return originalFetch(url, ...rest);
  };

  try {
    const lowHit = {
      rank: 1,
      id: 'builtin-who#p4#c0',
      namespace: 'builtin',
      title: 'WHO-FAO Healthy Diets Report',
      source: 'who.pdf',
      publisher: 'WHO',
      sourceUrl: '',
      page: 4,
      citation: '[WHO-FAO Healthy Diets Report, p. 4]',
      scores: { rerank: 0.002, dense: 0.08, lexical: 0.1 },
      text: 'Copyright page.',
    };

    // Even if router tries to label an unsupported factual question as general_chat,
    // routeConversation must force it into document-only RAG and refuse cleanly.
    const groq = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({ route: 'chat', intent: 'general_chat' }) } }],
          }),
        },
      },
    };

    const res = await answerQuestion(
      { question: 'What is the population of Tokyo in 2025?', scope: 'both' },
      { retrieve: async () => ({ results: [lowHit], stats: {} }), groq }
    );

    assert.equal(tavilyCalls, 0);
    assert.equal(res.mode, 'rag');
    assert.equal(res.refused, true);
    assert.equal(res.canSearchWeb, true);
    assert.equal(res.grounded, false);
    assert.match(res.answer, /search the web/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transcribeAudio sends audio to Groq Whisper and returns plain text', async () => {
  let receivedModel = '';
  const groq = {
    audio: {
      transcriptions: {
        create: async (params) => {
          receivedModel = params.model;
          return { text: '  What are the four core principles of healthy diets?  ' };
        },
      },
    },
  };

  const res = await transcribeAudio(
    { buffer: Buffer.from('fake-audio-bytes'), filename: 'voice.webm', mimetype: 'audio/webm' },
    { groq, toFile: async (buf, name) => ({ buf, name }) }
  );

  assert.match(receivedModel, /whisper/i);
  assert.equal(res.text, 'What are the four core principles of healthy diets?');
});

