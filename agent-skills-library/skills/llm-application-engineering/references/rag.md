# Retrieval-augmented generation (RAG)

## Contents
1. When RAG fits
2. Pipeline overview
3. Ingestion and parsing
4. Chunking
5. Embeddings and indexing
6. Retrieval: hybrid, filters, reranking
7. Query understanding
8. Prompting for grounded answers
9. Access control and security
10. Evaluation
11. Debugging playbook
12. Advanced patterns

## 1. When RAG fits
Use RAG when answers depend on private, large, or frequently changing knowledge, when citations are needed, or when fine-tuning is impractical. If the whole corpus fits comfortably in context and changes rarely, "put everything in the prompt with caching" may be simpler and better. For structured data, prefer querying the database or API through tools (text-to-SQL with guardrails) over embedding rows.

## 2. Pipeline overview
```
Sources -> parse/clean -> chunk (+metadata) -> embed -> index (vector + keyword)
Query -> rewrite/expand -> retrieve (hybrid, filters) -> rerank -> assemble context -> generate with citations -> verify
```
Each stage can be evaluated and improved separately. Most quality problems originate in parsing, chunking, and retrieval, not the generator.

## 3. Ingestion and parsing
- Preserve structure: headings, tables, lists, code blocks, page numbers, URLs. Use layout-aware parsers for PDFs (e.g., Docling, Unstructured, PyMuPDF, cloud document AI) and OCR for scans; verify table extraction.
- Clean boilerplate (headers, footers, navigation, cookie banners), deduplicate near-identical documents, and normalize whitespace and encodings (handle Arabic normalization consistently if relevant: diacritics, alef/yeh variants, tatweel, Arabic-Indic digits).
- Attach metadata: source id, title, section path, author, date, version, language, permissions/ACL, doc type. Metadata enables filtering, freshness ranking, and citations.
- Track versions and deletions: re-index on change; remove stale chunks; store content hashes for incremental updates.

## 4. Chunking
- Chunk by **semantic/structural boundaries** (sections, paragraphs, function definitions) rather than fixed characters when possible; typical sizes 200 to 800 tokens with 10 to 20% overlap; tune on your evals.
- Keep chunks self-contained: prepend the document title and section path ("Contextual retrieval": add a short generated context sentence explaining where the chunk sits in the document) to reduce ambiguity, especially for pronouns and tables.
- Keep tables and code intact; index parent-child: retrieve small chunks, return the larger parent section to the generator.
- Different corpora need different strategies (legal clauses, FAQs, code, chat logs, transcripts). Measure rather than assume.

## 5. Embeddings and indexing
- Choose an embedding model by retrieval quality on **your** data and languages (check multilingual and Arabic performance if needed), dimension/cost, latency, and license. Use the same model for documents and queries, and follow the model's instructions about query/document prefixes.
- Normalize vectors when using cosine similarity; store the embedding model version with the index and re-embed on upgrade.
- Vector stores: pgvector (with HNSW/IVFFlat) for moderate scale and transactional convenience; dedicated engines (Qdrant, Weaviate, Milvus, Pinecone, OpenSearch/Elasticsearch kNN) for scale and features. Approximate nearest neighbor settings trade recall for speed; measure recall against exact search.
- Maintain a **keyword index** (BM25) alongside vectors.

## 6. Retrieval: hybrid, filters, reranking
1. **Hybrid search**: combine BM25 (exact terms, identifiers, rare words, names) with dense vectors (semantics) using reciprocal rank fusion or weighted scores. Hybrid usually beats either alone.
2. **Metadata filtering**: filter by tenant, permissions, date, language, and document type before or during ANN search.
3. **Over-retrieve then rerank**: fetch 20 to 100 candidates, rerank with a cross-encoder or reranker model (Cohere Rerank, bge-reranker, Voyage rerank, or LLM-based), and pass the top 3 to 10 to the generator.
4. **Diversity**: use MMR or per-document caps to avoid near-duplicate chunks filling the context.
5. Consider recency boosts for time-sensitive corpora.

## 7. Query understanding
- Rewrite conversational follow-ups into standalone queries using chat history.
- Expand or decompose complex questions into sub-queries (multi-hop) and merge results; optionally use HyDE (generate a hypothetical answer to embed) for sparse queries.
- Route: some queries need no retrieval, some need a database/tool, some need web search. A lightweight classifier or the model's tool choice can decide.
- Detect out-of-scope or unanswerable queries and respond accordingly.

## 8. Prompting for grounded answers
```
<instructions>
Answer the question using only the sources below. Cite sources by id like [S2] after each claim.
If the sources do not contain the answer, say so and state what is missing; do not guess.
If sources conflict, present both and note the discrepancy.
</instructions>
<sources>
<source id="S1" title="..." date="...">...</source>
<source id="S2" title="..." date="...">...</source>
</sources>
<question>...</question>
```
- Put sources before the question; label each with an id and metadata; ask for quotes or citations, then verify that each citation id exists and the cited text supports the claim (programmatic check plus optional LLM verification).
- Ask for concise answers with the evidence; avoid mixing outside knowledge silently.
- Treat retrieved text as **untrusted**: it can contain injected instructions. Delimit it and never let it change tool permissions.

## 9. Access control and security
- Enforce document-level permissions **at retrieval time** (filter by the user's ACLs), never after generation and never by asking the model to hide things.
- Partition indexes or namespaces per tenant when isolation matters; include tenant id in every query filter.
- Scan ingested documents for malware and hidden text; log provenance for each chunk; monitor for poisoned or manipulated documents.
- Redact secrets and PII at ingestion if policy requires; respect retention and deletion (delete embeddings too).
- See `security-review/references/llm-and-agent-security.md` (vector and embedding weaknesses, prompt injection).

## 10. Evaluation
- Build a question set with labeled relevant documents/passages (or ground-truth answers). Include unanswerable questions and multi-hop questions.
- **Retrieval metrics**: recall@k, hit rate, MRR, NDCG; check whether the needed chunk is even in the candidate set.
- **Generation metrics**: faithfulness/groundedness (are claims supported by the context?), answer relevance (does it address the question?), completeness, citation accuracy, refusal correctness on unanswerable items.
- Evaluate end to end and per stage; tune chunking, top-k, hybrid weights, reranking, and prompts against these metrics.
- Monitor in production: retrieval empty rates, low-similarity queries, user feedback, "I don't know" rate, latency, cost.

## 11. Debugging playbook
| Symptom | Likely cause | Try |
|---|---|---|
| Correct info exists but answer is wrong or "not found" | Retrieval miss | Inspect top-k; add BM25; improve chunking/context; increase k with reranker; rewrite query |
| Retrieves relevant doc but answer ignores it | Context too long or noisy; instruction weak | Fewer, better chunks; reorder; stronger grounding instructions |
| Hallucinated details | Model filling gaps | Require citations; allow "unknown"; verifier step; lower temperature |
| Outdated answers | Stale index or no recency signal | Incremental re-indexing; date metadata; recency boost |
| Names, codes, IDs not found | Dense-only retrieval | Add keyword/BM25 hybrid; exact-match field search |
| Table questions fail | Tables flattened by parser | Better parsing; table-aware chunks; serialize as Markdown/CSV; use SQL tool |
| Arabic or multilingual queries weak | Embedding model or normalization | Multilingual embedding model; normalization; language-specific analyzers; evaluate per language |
| Slow | Too many candidates, big reranker, huge context | Cache; smaller reranker; reduce k; parallelize; streaming |

## 12. Advanced patterns
- **Contextual retrieval / late chunking** for better chunk embeddings.
- **Parent-document and sentence-window retrieval** for precision plus context.
- **Agentic RAG**: the model decides when and how to search, reformulates queries, and iterates until it has enough evidence, with a step cap.
- **GraphRAG / knowledge graphs** for relationship-heavy corpora and global summarization questions; adds pipeline complexity, so justify with evals.
- **Structured + unstructured hybrid**: combine SQL tools with document retrieval.
- **Caching**: semantic and exact caches for frequent queries, with invalidation on source updates.
