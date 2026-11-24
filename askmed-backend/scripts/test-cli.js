#!/usr/bin/env node
// Quick terminal tester for the AskMed backend.
// Usage:
//   node scripts/test-cli.js health
//   node scripts/test-cli.js stats
//   node scripts/test-cli.js ingest <file.pdf> [builtin|personal] ["Title"] ["Publisher"]
//   node scripts/test-cli.js seed [dir=./data/builtin]            (ingest every PDF in dir to builtin)
//   node scripts/test-cli.js ask "<question>" [builtin|personal|both]
//   node scripts/test-cli.js batch [scope]                         (paste multiple questions, blank line or END to submit)
//   node scripts/test-cli.js retrieve "<question>" [scope]
//   node scripts/test-cli.js chat [scope]                          (interactive REPL; type /batch to paste multiple questions)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';

const BASE = process.env.ASKMED_URL || `http://localhost:${process.env.PORT || 5000}`;
const [cmd, ...args] = process.argv.slice(2);

async function call(method, url, body, isForm = false) {
  const res = await fetch(BASE + url, {
    method,
    headers: isForm || !body ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ingest(file, namespace = 'personal', title, publisher) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), path.basename(file));
  form.append('namespace', namespace);
  if (title) form.append('title', title);
  if (publisher) form.append('publisher', publisher);
  const { status, data } = await call('POST', '/api/documents/ingest', form, true);
  console.log(status, JSON.stringify(data, null, 2));
}

function printAnswer(d) {
  if (d.error) return console.log('ERROR:', d.error);
  if (d.conversational) {
    console.log('\n' + d.answer);
    console.log(`\n[intent=${d.intent} | retrieval skipped | scope=${d.scope}]`);
    return;
  }
  console.log('\n================ ANSWER ================\n');
  console.log(d.answer);
  console.log('\n---------------- meta ------------------');
  console.log(`refused=${d.refused} grounded=${d.grounded} emergency=${d.emergency} scope=${d.scope}`);
  console.log(
    `retrieval: accepted=${d.retrieval.accepted ?? d.retrieval.passedThreshold}/${d.retrieval.retrieved} ` +
      `(passedThreshold=${d.retrieval.passedThreshold}, gate=${d.retrieval.gateMode || 'n/a'}, threshold=${d.retrieval.threshold}, ` +
      `top=${d.retrieval.topScore}, acceptedTop=${d.retrieval.acceptedTopScore ?? d.retrieval.topScore})`
  );
  (d.warnings || []).forEach((w) => console.log('WARNING:', w));
  console.log('\nSources:');
  d.sources.forEach((s) =>
    console.log(
      `  ${s.rank}. ${s.citation} [${s.namespace}]${s.acceptedBy ? ` (${s.acceptedBy})` : ''} rerank=${s.scores.rerank} dense=${s.scores.dense} lexical=${s.scores.lexical}`
    )
  );
  console.log('\nDisclaimer:', d.disclaimer);
  if (d.generation) console.log(`\n(${d.generation.model}, gen ${d.generation.tookMs} ms, total ${d.tookMs} ms)`);
}

function printBatch(b) {
  if (b.error) return console.log('ERROR:', b.error);
  console.log(
    `\n================ BATCH SUMMARY (${b.total} questions | answered=${b.answered} refused=${b.refused} failed=${b.failed} dedup=${b.deduplicated} | ${b.tookMs} ms) ================`
  );
  for (const item of b.results) {
    console.log(`\n--- [${item.index}/${b.total}] ${item.question}${item.deduplicated ? ' (cached duplicate)' : ''} ---`);
    if (item.error) {
      console.log(`ERROR (${item.status || 500}): ${item.error}`);
      continue;
    }
    if (item.conversational) {
      console.log(item.answer);
      console.log(`[intent=${item.intent} | retrieval skipped | scope=${item.scope}]`);
      continue;
    }
    console.log(item.answer);
    const cites = (item.citations || []).map((c) => c.citation).join(', ') || 'none';
    console.log(
      `[refused=${item.refused} | grounded=${item.grounded} | gate=${item.retrieval?.gateMode || 'n/a'} | top=${item.retrieval?.topScore} | citations: ${cites}]`
    );
    (item.warnings || []).forEach((w) => console.log(`WARNING: ${w}`));
  }
}

async function readMultilineQuestions(rl) {
  console.log('Paste your questions (one per line, numbered or plain). Enter an empty line or "END" when done:');
  const lines = [];
  for (;;) {
    let line;
    try {
      line = await rl.question('');
    } catch {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase() === 'END') {
      if (lines.length) break;
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

switch (cmd) {
  case 'health':
  case 'stats': {
    const { status, data } = await call('GET', cmd === 'health' ? '/api/health' : '/api/documents/stats');
    console.log(status, JSON.stringify(data, null, 2));
    break;
  }
  case 'ingest':
    if (!args[0]) throw new Error('Usage: ingest <file.pdf> [namespace] [title] [publisher]');
    await ingest(...args);
    break;
  case 'seed': {
    const dir = args[0] || './data/builtin';
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    for (const f of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'))) {
      const m = manifest[f] || {};
      console.log(`\n>> Ingesting ${f}`);
      await ingest(path.join(dir, f), 'builtin', m.title, m.publisher);
    }
    break;
  }
  case 'ask': {
    const { data } = await call('POST', '/api/chat', { question: args[0], scope: args[1] || 'both' });
    printAnswer(data);
    break;
  }
  case 'batch': {
    const scope = args[0] || 'both';
    let payload;
    if (!process.stdin.isTTY) {
      payload = fs.readFileSync(0, 'utf8');
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      payload = await readMultilineQuestions(rl);
      rl.close();
    }
    const { data } = await call('POST', '/api/chat/batch', { questions: payload, scope });
    printBatch(data);
    break;
  }
  case 'retrieve': {
    const { status, data } = await call('POST', '/api/chat/retrieve', { question: args[0], scope: args[1] || 'both' });
    console.log(status, JSON.stringify(data, null, 2));
    break;
  }
  case 'chat': {
    const scope = args[0] || 'both';
    let sessionId = randomUUID();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(
      `AskMed interactive (scope=${scope}, session=${sessionId.slice(0, 8)}). ` +
        'Type "/batch" for multiple questions, "/new" to reset chat memory, or "exit" to quit.'
    );
    for (;;) {
      const q = (await rl.question('\nYou> ')).trim();
      if (!q || q === 'exit') break;
      if (q === '/new' || q === '/clear') {
        await call('DELETE', `/api/chat/session/${sessionId}`);
        sessionId = randomUUID();
        console.log(`Started fresh conversation session (${sessionId.slice(0, 8)}).`);
        continue;
      }
      if (q === '/batch') {
        const block = await readMultilineQuestions(rl);
        const { data } = await call('POST', '/api/chat/batch', { questions: block, scope });
        printBatch(data);
        continue;
      }
      const { data } = await call('POST', '/api/chat', { question: q, scope, sessionId });
      printAnswer(data);
    }
    rl.close();
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n'));
}

