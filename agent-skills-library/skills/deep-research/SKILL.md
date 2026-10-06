---
name: deep-research
description: Conducts rigorous, well-sourced research on any topic using web search and document tools: scoping the question, planning searches, gathering primary and secondary sources, evaluating credibility, cross-verifying claims, synthesizing findings, and writing a cited report with calibrated confidence. Use whenever the user asks to research, investigate, compare options, fact-check, survey the state of the art, do a literature review, evaluate a technology or vendor, find current information, or produce a report, brief, or recommendation that must be accurate and up to date.
license: MIT
metadata:
  category: research
  version: "1.0"
---

# Deep Research

Produce answers a careful expert would trust: current, sourced, cross-checked, and honest about uncertainty. Never present memory as verified fact for anything that may have changed.

## 1. Research loop

1. **Scope** the question
2. **Plan** the search strategy
3. **Gather** sources
4. **Evaluate** and verify
5. **Synthesize** into findings
6. **Write** the deliverable with citations and confidence
7. **Review** for gaps and bias

Iterate: findings from step 4 often reveal new sub-questions; return to step 2.

## 2. Scope the question

- Restate the question precisely: what decision or understanding will this inform? Who is the audience and what is their expertise?
- Define **boundaries**: time range, geography, domain, depth, and exclusions.
- Define **deliverable and length**: quick answer (one paragraph with 1 to 3 sources), brief (1 page), or full report (structured, many sources). Match effort to stakes: high-stakes or contested topics deserve deeper checking.
- Decompose into **sub-questions** that together answer the main question. For comparisons list the criteria first (cost, features, maturity, security, license, ecosystem, performance) so each option is treated evenly.
- Note the **current date** and treat anything time-sensitive (versions, prices, laws, leadership, benchmarks, outages, release status) as needing a fresh search.
- If the request is ambiguous in a way that changes the work, ask one focused question; otherwise state assumptions and proceed.

## 3. Plan searches

- Start broad to map the landscape (2 to 3 queries), then narrow with specific terms, names, versions, and dates.
- Use **short, distinct queries** (1 to 6 words). Reformulate rather than repeating: synonyms, official product names, error strings in quotes, `site:` for known domains, `filetype:pdf`, date words ("2026").
- Search **each item separately** in multi-part or comparison tasks; combined queries return shallow results.
- Scale effort: one lookup for a single fact; several searches for a medium task; many (10 to 20+) for broad surveys, comparisons, and contested topics.
- Prefer sources by type:
  - **Primary**: official documentation, standards (RFCs, ISO, W3C), laws and regulations, court documents, datasets, original papers, company filings, release notes, source code, changelogs, direct statements.
  - **Secondary**: reputable journalism, review articles, textbooks, well-maintained tutorials and analyses by recognized experts.
  - **Tertiary**: encyclopedias and aggregators; good for orientation, then follow their citations to primary sources.
  - **Community**: forums, issue trackers, and social posts reveal real-world problems, but treat as anecdotal until corroborated.
- For technical topics also check: GitHub issues and releases, security advisories (OSV, GHSA, CVE), benchmarks with methodology, conference talks, vendor status pages.
- For academic topics use Google Scholar, Semantic Scholar, arXiv, PubMed, ACM/IEEE, and publisher sites; follow citations forward and backward (snowballing).
- Fetch the full page when a snippet is insufficient; read beyond the abstract for the numbers, method, and caveats.

## 4. Evaluate sources

Use **SIFT** (lateral reading) for unfamiliar sources, and the checks in `references/source-evaluation.md`:
- **Stop**: pause before trusting or sharing; know what you are trying to verify.
- **Investigate the source**: who is behind it, what is their expertise and incentives? Open new tabs and search about the site or author rather than trusting its own "About" page.
- **Find better coverage**: look for the best available source for the claim; see if experts agree.
- **Trace claims** to the original context: locate the original study, document, data, or quote and read what it actually says.

Quality signals: primary origin, named expert authors, transparent methodology and data, dates and versions, editorial standards, corrections policy, agreement among independent sources. Red flags: no author or date, anonymous claims, sensational language, missing citations, circular sourcing (many articles citing one), content marketing disguised as analysis, AI-generated spam, outdated pages presented as current.

**Verify key claims with at least two independent sources** (independent means not copying each other). For numbers, dates, and quotes prefer the original. If sources conflict, say so, explain plausible reasons (different definitions, dates, methodology), and prefer the most authoritative and recent, or present the range.

## 5. Take notes as you go

Keep a running **source log** (in your working notes):
```
[S1] Title | Publisher/author | Date | URL | Type (primary/secondary) | Reliability (H/M/L)
     Key facts: ... | Caveats: ...
```
Record claims with their source at the moment you read them so the report can cite accurately and nothing is attributed from memory. Distinguish:
- **Fact** (verifiable, cited), **Inference** (your reasoning from facts, labeled), **Opinion/claim** (attributed to whoever holds it), and **Unknown** (not found).

## 6. Synthesize

- Organize by **question**, not by source. Combine evidence across sources into statements, noting agreement and disagreement.
- Identify **patterns, trade-offs, and causal claims**; test causal claims against confounders and alternative explanations.
- Quantify where possible; compare like with like (same period, currency, definition, benchmark conditions).
- Check for **bias**: your own confirmation bias (did you search for disconfirming evidence?), survivorship bias, vendor bias, recency bias, and geographic or language bias in sources.
- Steelman opposing views on contested topics; report the strongest case for each side fairly and stay politically and commercially neutral.
- Assign **confidence** to major conclusions:
  - **High**: multiple independent authoritative sources agree; recent; direct evidence.
  - **Medium**: good sources but limited, partly indirect, or somewhat dated.
  - **Low**: single source, anecdotal, conflicting, or inferred.
- List **what you could not find** and what would change the conclusion.

## 7. Write the deliverable

Structure (scale to the request; see `references/report-template.md`):
1. **Bottom line** first: the answer or recommendation in 2 to 5 sentences with confidence.
2. **Key findings** with evidence and citations.
3. **Analysis / comparison** (tables for multi-criteria comparisons).
4. **Caveats and uncertainty**, conflicts between sources, and gaps.
5. **Recommendations / next steps** when a decision is needed.
6. **Sources** with title, publisher, date, URL.

Rules:
- **Cite specific claims**, not whole paragraphs; every number, date, and non-obvious factual statement traces to a source you actually read. Never invent or guess citations, URLs, quotes, statistics, or authors. If you did not verify it, say so or leave it out.
- **Paraphrase in your own words.** Quote only short exact phrases when wording itself matters (a legal term, a definition, an official statement), keep quotes brief, attribute them, and do not reproduce long passages, song lyrics, or full articles. Summaries must be substantially reworded and much shorter than the original.
- Give dates for time-sensitive facts ("as of September 2026") and link to the source page so the reader can re-check.
- Write clearly and concisely: plain words, short paragraphs, define terms, no filler. Tables for comparisons, lists for enumerations, prose for reasoning.
- Match the reader's level; include a short glossary if needed.
- Be direct: state conclusions; do not hedge everything. Reserve hedges for real uncertainty and explain it.

## 8. Special research types

### Comparing technologies, libraries, or vendors
Criteria: fit for requirements, maturity and maintenance (release cadence, open issues, bus factor), community and ecosystem, documentation quality, license, security record (advisories, response time), performance evidence (reproducible benchmarks), operational cost, lock-in and exit path, team skills, roadmap and funding. Check the actual repository and changelog, not just marketing pages. Produce a weighted decision matrix and a recommendation with conditions ("choose X unless Y").

### Fact-checking a claim
Identify the exact claim; find its origin; check primary evidence; look for expert consensus and fact-check organizations; check date, context, and whether images or quotes are authentic (reverse image search, original transcripts); rate as true / mostly true / misleading / false / unverifiable with an explanation.

### Literature review (academic)
Define the research question and inclusion criteria; search multiple databases with documented queries; screen titles/abstracts then full texts; extract data into a matrix (study, method, sample, findings, limitations); group by theme or method; assess quality and bias; identify gaps and open problems; cite consistently (APA, IEEE, etc.). Read papers in the order: abstract, conclusion, figures, methods, then details. Prefer peer-reviewed work, check for retractions, and note preprint status.

### Market or landscape scans
Define segments and players; gather from company sites, filings, funding databases, analyst reports (note paywalls), product docs, and user reviews; capture pricing and positioning with dates; note that markets change quickly and label the snapshot date.

### Security and vulnerability research (defensive)
Use official advisories, vendor bulletins, CVE/NVD, OSV, CISA KEV, and upstream commits; confirm affected versions and fixes; avoid reproducing weaponized exploit code; focus on detection, mitigation, and remediation guidance.

## 9. Quality checklist before delivering

- [ ] The question asked is the question answered; scope and assumptions stated
- [ ] Time-sensitive facts come from fresh sources with dates
- [ ] Key claims verified by two or more independent, credible sources (or flagged)
- [ ] Every citation is real, was read, and supports the exact claim
- [ ] Conflicts, uncertainty, and gaps are stated honestly with confidence levels
- [ ] Opposing views represented fairly; my own bias checked
- [ ] Quotes short and attributed; everything else in my own words
- [ ] Conclusions and recommendations follow from evidence and are actionable

## Reference files

- `references/source-evaluation.md`: credibility criteria, statistics and study checks, search operators, and source-type notes
- `references/report-template.md`: templates for quick answers, briefs, comparison reports, and decision memos
