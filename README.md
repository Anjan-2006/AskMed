# AskMed

AskMed is a document-first, healthcare-only Retrieval-Augmented Generation (RAG) assistant. Users upload one or more healthcare PDF documents (such as clinical guidelines, nutrition briefs, lab reports, or medical research papers) into an isolated conversation and ask grounded questions with verifiable page-level citations and an in-app PDF viewer.

The repository is organized as a two-package workspace:

- `askmed-backend/` — Node.js + Express 5 API server, Advanced RAG pipeline, Pinecone hybrid search + cross-encoder reranking, Groq LLM and Whisper integration, Tavily consent-based web search, MongoDB Atlas persistence, and GridFS PDF storage.
- `askmed-frontend/` — React 19 + TypeScript + Vite web application with document upload, multi-conversation sidebar, clickable citation chips, portal-based PDF hover previews, side-by-side PDF.js viewer, voice dictation, and text-to-speech playback.

---

## Table of Contents

1. [Core Capabilities](#core-capabilities)
2. [System Architecture](#system-architecture)
3. [End-to-End RAG Pipeline](#end-to-end-rag-pipeline)
4. [Repository Structure](#repository-structure)
5. [Backend API Reference](#backend-api-reference)
6. [Frontend Architecture and UX](#frontend-architecture-and-ux)
7. [Data Persistence and Isolation](#data-persistence-and-isolation)
8. [Safety and Healthcare Domain Guard](#safety-and-healthcare-domain-guard)
9. [Evaluation Suite and Verified Metrics](#evaluation-suite-and-verified-metrics)
10. [Local Development Setup](#local-development-setup)
11. [Environment Variables](#environment-variables)
12. [Testing and Verification](#testing-and-verification)
13. [Production Deployment (Render + Vercel)](#production-deployment-render--vercel)

---

## Core Capabilities

- **Document-First Healthcare Conversations:** Each conversation starts by uploading one or more PDF files (up to 25 MB each) into its own isolated Pinecone namespace (`conv_<id>`), preventing cross-conversation leakage.
- **Original PDF Storage and In-App Viewing:** Uploaded PDFs are persisted in MongoDB Atlas GridFS (`gridFsFileId`), streamed securely through a device-scoped endpoint, and rendered directly inside the app with PDF.js (`pdfjs-dist`).
- **Interactive Page-Level Citations:** Every grounded factual claim includes inline `[Source Title, p. N]` citations rendered as interactive chips. Hovering over a citation opens a crisp rendered thumbnail of the cited PDF page via a React Portal; clicking opens the side-by-side PDF viewer jumped directly to that page.
- **Hybrid Retrieval with Reranking:** Combines dense semantic vector search (`llama-text-embed-v2`), native lexical/BM25 full-text search, Reciprocal Rank Fusion (RRF), and cross-encoder reranking (`bge-reranker-v2-m3`) before relevance gating.
- **History-Aware Query Planning:** An LLM router resolves multi-turn pronouns and ordinal references (for example, "explain the second principle"), decomposes comparison queries into per-concept sub-queries, and expands broad summary requests across sections.
- **Strict Grounding and Refusal Discipline:** Enforces a relevance gate (`MIN_RELEVANCE_SCORE = 0.15`), validates every inline citation against actually retrieved passages, runs a single citation-revision pass if inline citations were omitted, and refuses cleanly without guessing when evidence is absent.
- **Healthcare-Only Domain Guard:** Rejects non-healthcare queries immediately before hitting Pinecone or Tavily, without offering web search.
- **Consent-Based Web Search (Tavily):** When a valid healthcare question is not covered by the uploaded PDFs, AskMed refuses from documents and offers an explicit opt-in button to search the web via Tavily. No web calls occur without user consent.
- **Voice Input and Speech Output:** Supports browser microphone recording transcribed through Groq Whisper (`whisper-large-v3-turbo`) as well as browser Web Speech API read-aloud (`Listen`) for assistant responses.
- **Batch Q&A Endpoint:** Processes multiple questions in one request with deduplication, order preservation, per-question refusal/error isolation, and bounded concurrency.
- **Device-Scoped Persistence Without Accounts:** Uses a persistent browser-generated `x-device-id` header and `localStorage` active-conversation restoration so conversations survive page reloads while isolating devices from one another.

---

## System Architecture

```text
+-------------------------------------------------------------------+
|                     askmed-frontend (Vercel)                      |
|  React 19 + TypeScript + Vite + PDF.js (pdfjs-dist)               |
|  - Conversation Sidebar & localStorage state restoration          |
|  - Multi-PDF Upload & Document Context Bar                        |
|  - Markdown Chat, Citation Chips & Portal Hover Previews          |
|  - Side-by-Side PDF Viewer Panel (HiDPI canvas + render queue)    |
|  - Voice Dictation (MediaRecorder) & Speech Playback              |
+---------------------------------+---------------------------------+
                                  |
                                  | HTTPS JSON + Multipart + PDF Stream
                                  | (x-device-id header / deviceId query)
                                  v
+-------------------------------------------------------------------+
|                      askmed-backend (Render)                      |
|  Node.js + Express 5 + Multer (memoryStorage)                     |
|                                                                   |
|  Routes:                                                          |
|   /api/conversations   /api/documents   /api/chat   /api/health   |
|                                                                   |
|  Services:                                                        |
|   conversationService  ragService       retrieveService           |
|   ingestService        pdfStorageService webSearchService         |
|   transcribeService    batchService     sessionStore              |
+---------+--------------------+--------------------+---------------+
          |                    |                    |
          v                    v                    v
+-------------------+  +------------------+  +----------------------+
| MongoDB Atlas     |  | Pinecone         |  | Groq & Tavily APIs   |
| - Conversations   |  | - llama-text-    |  | - openai/gpt-oss-120b|
| - Messages        |  |   embed-v2       |  | - whisper-large-v3-  |
| - Document Meta   |  | - BM25 Full-Text |  |   turbo (STT)        |
| - GridFS PDFs     |  | - bge-reranker-  |  | - Tavily Web Search  |
|   (askmed_pdfs)   |  |   v2-m3          |  |   (consent-only)     |
+-------------------+  +------------------+  +----------------------+
```

---

## End-to-End RAG Pipeline

### 1. Document Ingestion (`services/ingestService.js` + `services/pdfStorageService.js`)

1. A PDF is uploaded via `POST /api/conversations/:id/documents` (or `POST /api/documents/ingest`) using `multer.memoryStorage()` (max 25 MB).
2. `pdf-parse` extracts text page by page while preserving exact PDF page numbers.
3. Text is cleaned and segmented into overlapping page-aware chunks with metadata (`doc_id`, `title`, `page`, `chunk_index`, `chunk_text`, optional `publisher` and `source_url`).
4. Chunks are upserted into the conversation's isolated Pinecone namespace (`conv_<conversationId>`), where Pinecone's integrated `llama-text-embed-v2` model generates dense embeddings and indexes `chunk_text` and `title` for native full-text search.
5. In parallel, the raw PDF buffer is stored in MongoDB Atlas GridFS (`askmed_pdfs` bucket) and its `gridFsFileId` is recorded in the conversation's document metadata.

### 2. Query Routing and Planning (`routeConversation` in `services/ragService.js`)

1. **Emergency red-flag check:** Life-threatening medical red-flag phrases bypass casual chat routing and prepend an urgent emergency care notice.
2. **LLM Router (`openai/gpt-oss-120b`, JSON mode, `temperature: 0`):**
   - **Out-of-domain guard:** Non-healthcare questions return `route: "out_of_domain"` and are rejected immediately with zero Pinecone or Tavily calls.
   - **Pure conversational intents:** Simple greetings, thanks, goodbyes, or capability questions (when not explicitly referencing documents) are answered naturally without unnecessary vector retrieval.
   - **Document RAG planning:** Produces a standalone rewritten query resolving pronouns/ordinals from the last 10 turns of conversation history, classifies `queryType` (`standard`, `comparison`, or `summary`), and emits up to 4 targeted `subQueries` for comparison or broad summary questions.

### 3. Hybrid Retrieval and Reranking (`services/retrieveService.js`)

1. Meta-document framing (such as "according to the uploaded PDF") is stripped for cleaner semantic and cross-encoder matching.
2. Each query runs **dense semantic search** and **lexical full-text (BM25) search** against the target Pinecone namespace(s).
3. Candidate lists are merged using **Reciprocal Rank Fusion (RRF)** (`k = 60`).
4. Fused candidates are reranked using Pinecone's cross-encoder (`bge-reranker-v2-m3`).
5. **Relevance Gating (`selectRelevantPassages`):** Passages must pass the calibrated rerank threshold (`MIN_RELEVANCE_SCORE = 0.15`) or meet strict hybrid corroboration criteria. For comparison queries, evidence is checked per concept; if one side lacks evidence, AskMed refuses rather than guessing.

### 4. Grounded Generation and Citation Validation (`services/ragService.js`)

1. Accepted passages are formatted into a numbered `CONTEXT` block along with an explicit `ALLOWED CITATIONS` allowlist (`[Title, p. N]`).
2. `openai/gpt-oss-120b` generates a concise, grounded answer citing every factual claim from the allowlist.
3. `validateCitations()` parses all inline citations and verifies that every cited `(title, page)` pair actually exists in the retrieved passages.
4. If the first draft produced a substantive answer but omitted inline citations, a single targeted citation-revision pass (`temperature: 0`) adds valid citations strictly from the supplied context without fabricating facts.
5. If retrieval fails the relevance gate or the model reports insufficient evidence, AskMed returns a user-friendly refusal (`refused: true`, `canSearchWeb: true`) without exposing internal thresholds or scores, and offers consent-based Tavily web search.

---

## Repository Structure

```text
.
├── .gitignore
├── README.md
├── askmed-backend/
│   ├── server.js                           # Express 5 app, CORS, routes, /api/health, error handler
│   ├── package.json                        # ESM config, scripts, dependencies, Node >=18 engine
│   ├── .env.example                        # Environment variable template (no secrets)
│   ├── config/
│   │   ├── clients.js                      # Pinecone & Groq clients, index bootstrap, namespace helpers
│   │   └── db.js                           # Mongoose / MongoDB Atlas connection manager
│   ├── models/
│   │   └── Conversation.js                 # Device-scoped Conversation, Document, and Message schemas
│   ├── routes/
│   │   ├── conversations.js                # Conversation CRUD, PDF upload/streaming, messaging, web search
│   │   ├── documents.js                    # Legacy/direct ingest, stats, personal namespace clear
│   │   └── chat.js                         # Direct RAG chat, web search, Whisper transcribe, batch, retrieve
│   ├── services/
│   │   ├── conversationService.js          # Full conversation lifecycle and GridFS/Pinecone cleanup
│   │   ├── pdfStorageService.js            # MongoDB GridFS upload, streaming, and deletion
│   │   ├── ingestService.js                # Page-aware PDF extraction, chunking, and Pinecone upsert
│   │   ├── retrieveService.js              # Dense + BM25 search, RRF fusion, bge-reranker-v2-m3
│   │   ├── ragService.js                   # Domain guard, query planner, generation, citation validation
│   │   ├── webSearchService.js             # Consent-based Tavily healthcare search and synthesis
│   │   ├── transcribeService.js            # Groq Whisper audio-to-text transcription
│   │   ├── batchService.js                 # Multi-question batch execution with concurrency control
│   │   └── sessionStore.js                 # In-memory session store for direct /api/chat routes
│   ├── evaluation/
│   │   ├── dataset.json                    # 30 verified ground-truth questions from WHO Healthy Diets PDF
│   │   ├── dataset.md                      # Human-readable evaluation dataset
│   │   ├── run-evaluation.js               # Reproducible runner (--ids, --limit, --delay, --rescore)
│   │   ├── results.json                    # Captured 30-question live evaluation output
│   │   └── evaluation-report.md            # Aggregate metrics, category breakdown, and failure analysis
│   ├── data/builtin/
│   │   └── who_healthy_diets.pdf.pdf       # WHO-FAO Healthy Diets reference PDF (23 pages)
│   ├── scripts/
│   │   └── test-cli.js                     # Interactive CLI helper
│   └── tests/                              # 8 Node test runner suites (41 unit & integration tests)
│       ├── chatIntent.test.js
│       ├── conversationAndFollowup.test.js
│       ├── conversations.test.js
│       ├── domainGuard.test.js
│       ├── evaluationDataset.test.js
│       ├── ragUpgrades.test.js
│       ├── retrievalAndContext.test.js
│       └── webSearchAndTranscribe.test.js
└── askmed-frontend/
    ├── index.html                          # HTML shell, favicon, typography
    ├── package.json                        # React 19, TypeScript 5.8, Vite 6, pdfjs-dist
    ├── vite.config.ts                      # Dev server and /api proxy to localhost:5001
    ├── public/
    │   ├── askmed-logo.png                 # Brand logo and favicon
    │   └── pdf.worker.min.mjs              # PDF.js worker served directly from /public
    └── src/
        ├── main.tsx                        # React 19 StrictMode entry point
        ├── App.tsx                         # Root layout: sidebar, chat pane, split PDF viewer
        ├── api/askmedApi.ts                # Typed API client using VITE_API_BASE_URL + x-device-id
        ├── hooks/useConversations.ts       # Conversation state, localStorage persistence, CRUD actions
        ├── types/chat.ts                   # Shared TypeScript interfaces
        ├── components/
        │   ├── BrandMark.tsx               # AskMed logo component
        │   ├── Sidebar.tsx                 # Conversation list, rename, delete, connection status
        │   ├── DocumentUploadScreen.tsx    # Drag-and-drop multi-PDF setup screen
        │   ├── DocumentContextBar.tsx      # Active PDFs bar (click to open PDF viewer)
        │   ├── MessageList.tsx             # Scrollable conversation transcript
        │   ├── MessageItem.tsx             # User/assistant turns, copy, listen, web-search consent UI
        │   ├── MarkdownRenderer.tsx        # GFM markdown with inline citation parsing
        │   ├── CitationChip.tsx            # Clickable citation pill + React Portal PDF hover preview
        │   ├── PdfViewerPanel.tsx          # Side-by-side PDF.js viewer (page nav, zoom, open in tab)
        │   ├── Composer.tsx                # Chat input, keyboard shortcuts, voice dictation button
        │   ├── EmptyState.tsx              # Initial prompt suggestions inside active conversation
        │   └── LoadingIndicator.tsx        # Assistant thinking state
        ├── utils/
        │   ├── citations.ts                # Citation parsing and multi-PDF document matching
        │   ├── deviceId.ts                 # Persistent browser device ID generator
        │   ├── pdfLoader.ts                # Cached PDF.js loader + serialized per-canvas render queue
        │   └── speech.ts                   # Web Speech API TTS playback helper
        └── styles/
            ├── tokens.css                  # Design tokens (palette, spacing, typography)
            ├── global.css                  # Responsive layout, split PDF pane, sidebar, popover styles
            └── markdown.css                # Prose, table, list, and citation chip styles
```

---

## Backend API Reference

### Health and Service Info
- `GET /` — Returns API metadata and endpoint directory.
- `GET /api/health` — Checks live connectivity for Pinecone, Groq (`GROQ_MODEL`), and MongoDB Atlas; returns HTTP `200` when healthy or `503` when degraded.

### Device-Scoped Conversations (`/api/conversations`)
All routes read the device identifier from the `x-device-id` header (or `deviceId` query/body parameter).

- `POST /api/conversations` — Create a new conversation in `setup` mode with an isolated Pinecone namespace (`conv_<id>`).
- `GET /api/conversations` — List conversations belonging to the requesting device.
- `GET /api/conversations/:id` — Restore a conversation with its documents and full message history.
- `PATCH /api/conversations/:id` — Rename a conversation.
- `DELETE /api/conversations/:id` — Delete a conversation, its MongoDB record, all stored GridFS PDFs, and its entire Pinecone namespace.
- `POST /api/conversations/:id/documents` — Upload a PDF (`multipart/form-data`, field `file`), ingest chunks into Pinecone, and store the original file in GridFS.
- `GET /api/conversations/:id/documents/:docId/file` — Stream the original stored PDF inline (`application/pdf`) after verifying device ownership.
- `DELETE /api/conversations/:id/documents/:docId` — Remove a single document's chunks from Pinecone, delete its GridFS file, and remove it from metadata.
- `POST /api/conversations/:id/start` — Transition a conversation from `setup` to `active` once at least one PDF is indexed.
- `POST /api/conversations/:id/messages` — Ask a question grounded in the conversation's uploaded PDFs and persist both user and assistant turns.
- `POST /api/conversations/:id/web-search` — Execute consent-based Tavily healthcare web search for a previously refused question and persist the grounded web answer and sources.
- `POST /api/conversations/:id/web-search/dismiss` — Dismiss a pending web-search offer on a refusal message.

### Direct Chat, Voice, Batch, and Legacy Namespace Routes
- `POST /api/chat` — Direct RAG query (`{ question, scope: "builtin" | "personal" | "both", topK?, sessionId?, history? }`).
- `POST /api/chat/web-search` — Direct consent-based Tavily web search.
- `POST /api/chat/transcribe` — Multipart audio transcription (`field: audio`) via Groq Whisper.
- `POST /api/chat/batch` — Batch Q&A (`{ questions, scope?, topK?, concurrency? }`).
- `POST /api/chat/retrieve` — Retrieval-only diagnostic endpoint returning dense, lexical, RRF, and rerank scores without LLM generation.
- `DELETE /api/chat/session/:sessionId` — Clear an in-memory session.
- `POST /api/documents/ingest` — Direct PDF ingestion into `builtin` or `personal` namespace.
- `GET /api/documents/stats` — Vector counts per Pinecone namespace.
- `DELETE /api/documents/personal` — Clear the `personal` namespace.

---

## Frontend Architecture and UX

- **Split-Pane Workspace (`App.tsx`):** Responsive desktop and mobile layout featuring a collapsible conversation sidebar, document context bar, chat transcript, and an optional side-by-side PDF viewer panel.
- **PDF.js Rendering Reliability (`pdfLoader.ts` & `PdfViewerPanel.tsx`):**
  - Fetches each PDF once into an in-memory `PDFDocumentProxy` cache (`docCache`).
  - Uses a per-canvas Promise queue (`canvasTail`) combined with `AbortController` and `RenderTask.cancel()` so React 19 StrictMode double-mounts and rapid citation clicks never cause concurrent `canvas.render()` collisions.
  - Resets page count cleanly when switching between different PDFs in a multi-document conversation.
- **Portal-Based Citation Hover Previews (`CitationChip.tsx`):**
  - Renders hover preview cards into `document.body` via `createPortal` so they never violate HTML nesting (`<div>` inside `<p>`) and are never clipped by message containers or stacking contexts.
  - Automatically clamps preview coordinates to the viewport edges and dismisses immediately on window scroll or resize.
- **Active Conversation Persistence (`useConversations.ts`):**
  - Stores the active conversation ID under `askmed.activeConversationId.v1` in `localStorage`, validates the ID format before requesting it, restores the exact conversation on page refresh, and clears stale/deleted IDs gracefully.

---

## Data Persistence and Isolation

- **Device Isolation:** Every conversation stores a `deviceId` (UUID generated client-side and persisted in `localStorage`). All conversation reads, message sends, deletions, and GridFS PDF streams verify `conversation.deviceId === reqDeviceId` and return `404` for unauthorized or nonexistent IDs.
- **Pinecone Namespace Isolation:** Every conversation uses a dedicated namespace (`conv_<conversationId>`). Deleting a document removes only vectors matching `doc_id`; deleting a conversation deletes the entire namespace.
- **GridFS PDF Cleanup:** Uploading a PDF stores it in the `askmed_pdfs` GridFS bucket. Removing a document or deleting a conversation removes the corresponding GridFS files so no orphaned binaries remain.

---

## Safety and Healthcare Domain Guard

- **Healthcare-Only Enforcement:** Non-healthcare prompts (politics, sports, general coding, entertainment, etc.) are intercepted at the router before retrieval or web search and receive a clear scope notice without offering web search.
- **Emergency Red-Flag Notice:** Queries containing emergency indicators (such as chest pain, difficulty breathing, stroke signs, severe bleeding, or suicidal ideation) bypass casual chat routing and include an immediate medical emergency notice.
- **Clinical Disclaimer:** All RAG and web-search responses include a non-diagnostic medical information disclaimer.
- **No Unconsented Web Search:** Unsupported healthcare questions never trigger Tavily automatically; the user must explicitly approve web search.

---

## Evaluation Suite and Verified Metrics

AskMed includes a reproducible 30-question RAG evaluation suite in `askmed-backend/evaluation/` built directly from [who_healthy_diets.pdf.pdf](askmed-backend/data/builtin/who_healthy_diets.pdf.pdf) (23 PDF pages, 56 indexed chunks in namespace `builtin`).

### Dataset Composition (`evaluation/dataset.json`)
- Direct factual questions: 8 (`Q01`–`Q08`)
- Multi-passage synthesis questions: 5 (`Q09`–`Q13`)
- Evidence-based reasoning questions: 5 (`Q14`–`Q18`)
- Multi-turn follow-up questions: 4 (`Q19`–`Q22`)
- Unsupported healthcare questions (verified absent from PDF): 5 (`Q23`–`Q27`)
- Misleading / false-premise questions: 3 (`Q28`–`Q30`)

### Verified Results (`openai/gpt-oss-120b`, `MIN_RELEVANCE_SCORE = 0.15`)

| Metric | Denominator | Result |
|---|---|---|
| Overall Pass Rate | 30 questions | 90.0% (27/30) |
| Recall@5 | 25 answerable | 96.0% (24/25) |
| Mean Reciprocal Rank (MRR) | 25 answerable | 0.96 |
| Retrieval Failures | 25 answerable | 1 (`Q29`) |
| Answer Correctness (key-fact coverage >= 75%) | 25 answerable | 88.0% (22/25) |
| Faithfulness (grounded, 0 validator warnings) | 25 answerable | 88.0% (22/25) |
| Citation Accuracy (valid gold-page citation) | 25 answerable | 88.0% (22/25) |
| Refusal Accuracy | 5 unsupported | 100.0% (5/5) |
| False-Answer Rate | 5 unsupported | 0.0% (0/5) |

All 22 non-refused answers achieved 100% faithfulness and 100% valid page citations. All 3 failures (`Q09`, `Q29`, `Q30`) were conservative refusals rather than hallucinations; full details are documented in `askmed-backend/evaluation/evaluation-report.md`.

---

## Local Development Setup

### Prerequisites
- Node.js 18+ (Node 20+ recommended)
- Pinecone account and serverless index (`llama-text-embed-v2` dense embedding + full-text search on `chunk_text` and `title`)
- Groq API key
- MongoDB Atlas cluster URI
- Tavily API key (optional, required for consent-based web search)

### 1. Start the Backend

```bash
cd askmed-backend
cp .env.example .env
# Fill in PINECONE_API_KEY, GROQ_API_KEY, MONGODB_URI, TAVILY_API_KEY, and PORT=5001 in .env
npm install
npm run dev
```

Verify backend health at `http://localhost:5001/api/health`.

### 2. Start the Frontend

```bash
cd askmed-frontend
npm install
npm run dev
```

Open `http://localhost:5173`. During local development, Vite proxies `/api/*` requests to `http://localhost:5001` (configurable via `VITE_PROXY_TARGET`).

---

## Environment Variables

### Backend (`askmed-backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `5000` | HTTP server port (`5001` recommended locally; injected automatically on Render) |
| `PINECONE_API_KEY` | Yes | — | Pinecone API key |
| `PINECONE_INDEX_NAME` | No | `askmed-kb` | Pinecone index name |
| `PINECONE_CLOUD` | No | `aws` | Cloud provider if creating a new index |
| `PINECONE_REGION` | No | `us-east-1` | Region if creating a new index |
| `GROQ_API_KEY` | Yes | — | Groq API key for LLM generation and Whisper STT |
| `GROQ_MODEL` | No | `openai/gpt-oss-120b` | Primary chat and routing model |
| `GROQ_WHISPER_MODEL` | No | `whisper-large-v3-turbo` | Speech-to-text transcription model |
| `GROQ_TIMEOUT_MS` | No | `60000` | Request timeout for Groq calls in milliseconds |
| `MONGODB_URI` | Yes | — | MongoDB Atlas connection string (conversations + GridFS) |
| `TAVILY_API_KEY` | Optional | `""` | Tavily API key for consent-based web search |
| `TAVILY_MAX_RESULTS` | No | `5` | Max web search results (1–10) |
| `TAVILY_TIMEOUT_MS` | No | `20000` | Request timeout for Tavily calls in milliseconds |
| `MIN_RELEVANCE_SCORE` | No | `0.15` | Calibrated cross-encoder rerank threshold for relevance gating |
| `BATCH_CONCURRENCY` | No | `2` | Concurrent questions per `/api/chat/batch` call (1–5) |
| `BATCH_MAX_QUESTIONS` | No | `20` | Maximum questions per `/api/chat/batch` call (1–50) |

### Frontend (`askmed-frontend`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_API_BASE_URL` | Production | `""` | Base URL of the deployed backend (for example, `https://your-service.onrender.com`, no trailing slash). Leave empty in local dev to use the Vite `/api` proxy. |
| `VITE_PROXY_TARGET` | Local dev only | `http://localhost:5001` | Local backend target for Vite dev proxy |

---

## Testing and Verification

```bash
# Backend unit & integration tests (41 tests)
cd askmed-backend && npm test

# Frontend TypeScript check and production build
cd askmed-frontend && npm run build

# Re-score saved RAG evaluation results (0 API calls)
cd askmed-backend && node --env-file=.env evaluation/run-evaluation.js --rescore

# Run bounded 6-question live evaluation subset (1 per category)
cd askmed-backend && node --env-file=.env evaluation/run-evaluation.js --ids Q01,Q09,Q14,Q20,Q23,Q28 --delay 1200

# Run full 30-question live RAG evaluation
cd askmed-backend && node --env-file=.env evaluation/run-evaluation.js --delay 1500
```

---

## Production Deployment (Render + Vercel)

### Backend on Render
1. Create a new **Web Service** connected to your repository.
2. Set **Root Directory** to `askmed-backend`.
3. Set **Build Command** to `npm install` and **Start Command** to `npm start`.
4. Set **Health Check Path** to `/` (use `/api/health` manually to check external providers).
5. Add all required environment variables (`GROQ_API_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `MONGODB_URI`, `TAVILY_API_KEY`).
6. In MongoDB Atlas **Network Access**, allow `0.0.0.0/0` so Render's dynamic outbound IPs can connect.

### Frontend on Vercel + Custom Subdomain
1. Import the repository in Vercel and set **Root Directory** to `askmed-frontend`.
2. Select the **Vite** framework preset (`npm run build`, output directory `dist`).
3. Add the environment variable `VITE_API_BASE_URL` pointing to your Render backend URL (without a trailing slash).
4. In **Project Settings -> Domains**, add your custom subdomain (for example, `askmed.yourdomain.com`) and configure the `CNAME` record provided by Vercel in your DNS provider. Vercel provisions HTTPS automatically.

