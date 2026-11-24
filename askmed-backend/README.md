# AskMed Backend: Healthcare Information Retrieval Assistant (SDG 3)

An Advanced RAG backend built with Node.js, Express, Pinecone (integrated embeddings and reranking) and Groq (`openai/gpt-oss-120b` via `groq-sdk`).

## Setup
```bash
cd askmed-backend
npm install
# Put your keys in .env: PINECONE_API_KEY=...  GROQ_API_KEY=... (https://console.groq.com/keys)
npm start               # or: npm run dev  (auto-reload)
```
On the first start the server creates the serverless index `askmed-kb`, with `llama-text-embed-v2` mapped to `chunk_text`.

## Pipeline (what to show evaluators)
| Stage | Where | Detail |
|---|---|---|
| Extraction | `ingestService.extractPages` | `pdf-parse` reads the PDF page by page, so every chunk keeps its page number and source filename |
| Preprocessing | `cleanText` | De-hyphenation, removal of control characters, joining of soft line wraps, whitespace normalisation |
| Chunking | `chunkPage` | Page-aware (a chunk never crosses a page boundary). Chunks are about 1000 characters, split on sentence boundaries, with about 200 characters of overlap |
| Indexing | Pinecone | Integrated dense embeddings (`llama-text-embed-v2`) in two namespaces: `builtin` and `personal` |
| Hybrid retrieval | `retrieveService` | Dense top-20 per namespace, then BM25 over the candidate pool, then Reciprocal Rank Fusion (0.7 dense / 0.3 lexical) |
| Reranking | `pc.inference.rerank` | `bge-reranker-v2-m3` cross-encoder over the fused shortlist from both namespaces, then sorted by score |
| Gating | `ragService` | Passages scoring below `MIN_RELEVANCE_SCORE` are dropped. If none are left, the service refuses and the LLM is never called |
| Grounded generation | `ragService` | Strict system prompt: context only, inline `[Title, p. X]` citations, no diagnosis or dosing |
| Verification | `validateCitations` | Every citation in the answer is checked against the retrieved passages. Made-up citations are reported in `warnings` and set `grounded: false` |
| Safety | `ragService` | Red-flag phrases (e.g. chest pain, suicide) add an emergency notice. Every response carries a disclaimer |

## API
```bash
# Health (checks Pinecone + Groq)
curl localhost:5001/api/health

# Ingest a verified public-health PDF into builtin
curl -F "file=@who_hypertension.pdf" -F "namespace=builtin" \
     -F "title=WHO Hypertension Fact Sheet" -F "publisher=WHO" \
     -F "sourceUrl=https://www.who.int/news-room/fact-sheets/detail/hypertension" \
     localhost:5001/api/documents/ingest

# Ingest a personal PDF
curl -F "file=@my_lab_report.pdf" -F "namespace=personal" localhost:5001/api/documents/ingest

# Ask (scope: builtin | personal | both)
curl -X POST localhost:5001/api/chat -H "Content-Type: application/json" \
     -d '{"question":"What are the risk factors for hypertension?","scope":"builtin"}'

# Batch ask (array of strings OR multiline string; preserves order & deduplicates)
curl -X POST localhost:5001/api/chat/batch -H "Content-Type: application/json" \
     -d '{"questions":["What are the four core principles of healthy diets?","Why is dietary adequacy important?"],"scope":"builtin","concurrency":2}'

# Retrieval only: shows dense / BM25 / RRF / rerank scores (great for the IR demo)
curl -X POST localhost:5001/api/chat/retrieve -H "Content-Type: application/json" \
     -d '{"question":"symptoms of type 2 diabetes","scope":"both","topK":5}'

# Stats / reset personal KB
curl localhost:5001/api/documents/stats
curl -X DELETE localhost:5001/api/documents/personal
```

## CLI tester
```bash
node scripts/test-cli.js health
node scripts/test-cli.js ingest ./file.pdf builtin "WHO Malaria Fact Sheet" "WHO"
node scripts/test-cli.js seed ./data/builtin          # bulk-ingest PDFs into builtin
node scripts/test-cli.js ask "How is malaria transmitted?" builtin
node scripts/test-cli.js batch builtin                # paste multiple questions (blank line or END to run)
node scripts/test-cli.js retrieve "How is malaria transmitted?"
node scripts/test-cli.js chat both                    # interactive (type /batch to paste multiple questions)
```
For `seed`, you can add `data/builtin/manifest.json` to give each PDF a proper title and publisher:
```json
{ "who_malaria.pdf": { "title": "WHO Malaria Fact Sheet", "publisher": "WHO" } }
```

## Demo script for evaluation
1. **In-scope question** → a grounded answer with `[Source, p. X]` citations and `grounded: true`.
2. **Off-topic question** (e.g. "Who won the 2018 World Cup?") → `refused: true`, `reason: LOW_RELEVANCE`, and the LLM is not called.
3. **Scope switching**: ask the same question with `builtin`, `personal` and `both`, then compare the sources.
4. **Safety**: "I have chest pain, what should I do?" → the emergency notice and disclaimer appear.
5. **IR internals**: `/api/chat/retrieve` shows how the dense and BM25 rankings change after fusion and reranking.

> Note: Pinecone is eventually consistent. Wait a few seconds after ingesting before you query.

