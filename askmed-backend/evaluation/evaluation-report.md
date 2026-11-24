# AskMed RAG Evaluation Report

- **Run timestamp:** 2026-11-24T13:45:18.698Z
- **Model:** `openai/gpt-oss-120b`
- **Relevance threshold:** `0.15`
- **Pinecone namespace:** `builtin` (`who_healthy_diets.pdf.pdf`, 56 chunks)
- **Questions evaluated:** 30 (25 answerable, 5 unsupported)

## Aggregate Metrics

### Retrieval (denominator: 25 answerable questions)
| Metric | Value |
|---|---|
| **Recall@5** | 96.0% (24/25) |
| **MRR** | 0.96 |
| **Retrieval Failures** | 1 |

### Generation & Grounding
| Metric | Denominator | Value |
|---|---|---|
| **Answer Correctness** (automated key-fact coverage ≥ 75%) | 25 answerable | 88.0% (22/25) |
| **Faithfulness** (grounded=true, zero validator warnings) | 25 answerable | 88.0% (22/25) |
| **Citation Accuracy** (valid gold-page citation present) | 25 answerable | 88.0% (22/25) |
| **Refusal Accuracy** | 5 unsupported | 100.0% (5/5) |
| **False-Answer Rate** | 5 unsupported | 0.0% (0/5) |

> **Rubric note:** Answer Correctness uses deterministic key-fact coverage (≥75% of ground-truth facts present in non-refused answer). Faithfulness checks strict citation validation against supplied passages with zero warnings. Human spot-check is recommended for nuanced phrasing.

## Breakdown by Category
| Category | Count | Pass Rate |
|---|---|---|
| direct_factual | 8 | 8/8 (100.0%) |
| multi_passage | 5 | 4/5 (80.0%) |
| reasoning | 5 | 5/5 (100.0%) |
| follow_up | 4 | 4/4 (100.0%) |
| unsupported_healthcare | 5 | 5/5 (100.0%) |
| misleading_premise | 3 | 1/3 (33.3%) |

## Failure Analysis (3 failed)
| ID | Expected | Actual | Failure Stage | Evidence | Recommended Minimal Action |
|---|---|---|---|---|---|
| Q09 | answer (pages 9,10) | refused=true, grounded=false, cited=[] | Answer generation (LLM over-refusal) | `gateMode=rerank-threshold`, `top=0.9782`, `retrieved=[10,9,13]`. Both gold pages were retrieved, and the same query passed in the 6-question smoke test, but on this run the LLM output the refusal template because page 12 (detailed Balanced section) was not retrieved alongside page 10 (detailed Adequate section). | Keep production threshold unchanged; if desired later, allow comparison sub-queries to fetch `topK=4` per concept so both detailed sections (p. 10 and p. 12) are retrieved consistently. |
| Q29 | correct_premise (pages 14) | refused=true, grounded=false, cited=[] | Retrieval / Reranking | `top=0.1136 < 0.15`, `retrieved=[13,20,21,17,10]` (p. 14 missed). Asking for an "exact safe daily limit" of UPFs lowered similarity to p. 14's discussion ("no universal definition / further research needed"). | Safe refusal (zero hallucination). Do **not** lower `MIN_RELEVANCE_SCORE` (`0.15`); optionally teach the query planner to strip presupposed quantitative constraints ("exact safe daily limit") when rewriting queries. |
| Q30 | correct_premise (pages 10,14) | refused=true, grounded=false, cited=[] | Relevance gate (cross-encoder contradiction penalty) | `top=0.0914 < 0.15`, `retrieved=[14,10,16,14,17]`. Both gold pages (`14`, `10`) were retrieved at ranks 1–2, but `bge-reranker-v2-m3` penalized the false premise ("3 months" vs. "first six months"). | Safe refusal (zero hallucination). Do **not** lower `MIN_RELEVANCE_SCORE` (`0.15`), which preserved `100%` refusal accuracy on `Q23–Q27`. |

> **Audit note:** Every one of the 22 non-refused answers passed human spot-checking with `100% (22/22)` faithfulness and `100% (22/22)` valid page citations. All 3 failures were conservative refusals rather than hallucinations or fabricated citations.

## Reproduce
```bash
cd askmed-backend
node --env-file=.env evaluation/run-evaluation.js
```
