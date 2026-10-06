# Source evaluation and search techniques

## Contents
1. Credibility checklist
2. Lateral reading workflow
3. Checking statistics and studies
4. Checking technical claims and benchmarks
5. Checking images, quotes, and viral claims
6. Source type notes
7. Search operators and tactics
8. Citation hygiene
9. Common failure modes

## 1. Credibility checklist
Score each source High / Medium / Low on:
- **Authority**: is the author or organization qualified and accountable? Do they have expertise, credentials, or first-hand access?
- **Accuracy**: are claims verifiable, specific, and consistent with other reliable sources? Are sources cited?
- **Currency**: publication and update dates; is the content still valid for the versions and period in question?
- **Objectivity**: funding, incentives, conflicts of interest, sponsored content, advocacy, or product promotion?
- **Purpose**: inform, teach, sell, persuade, or entertain?
- **Coverage**: depth and completeness; are counterarguments or limitations acknowledged?
- **Provenance**: is this the original, or a summary of someone else's work?

Reliability heuristics by origin: official docs and standards for behavior of a product or protocol; peer-reviewed research for scientific findings (still check methodology); government statistical agencies for official statistics; primary datasets over reports about them; maintainers and issue trackers for software behavior; reputable newsrooms with corrections policies for events; personal blogs and forums as leads, not conclusions.

## 2. Lateral reading workflow (SIFT)
1. **Stop** before you use or share. Note the claim to verify.
2. **Investigate the source**: open a new tab and search the outlet or author name plus words like "funding", "review", "criticism", "about". Read what independent sources say about them, not their self-description.
3. **Find better coverage**: search the claim itself; look for higher-quality or original reporting, expert consensus, or fact checks.
4. **Trace claims, quotes, and media to the original context**: click through citations, find the study or document, and read the relevant part; verify that the source says what the article claims.
Spend seconds on obviously reliable sources and more time only when something seems surprising, high-stakes, or in conflict.

## 3. Checking statistics and studies
- Find the original study or dataset. Note who funded it and who conducted it.
- Sample: size, selection method, representativeness, response rate, population studied vs population generalized to.
- Design: randomized experiment vs observational; control group; blinding; preregistration; effect size and confidence intervals (not just p-values); multiple comparisons; replication.
- Measurement: definitions, instruments, time period, units, denominators (percent of what?), absolute vs relative risk ("doubles the risk" from 1 in 10,000 to 2 in 10,000 is small).
- Compare like with like: inflation-adjusted currency, per-capita normalization, consistent definitions across countries or years.
- Correlation vs causation; confounders; reverse causality; survivorship and selection bias; Simpson's paradox.
- Preprints are not peer reviewed; retracted papers persist online (check Retraction Watch, PubMed notices, publisher pages).
- Meta-analyses and systematic reviews outrank single studies; check their inclusion criteria and heterogeneity.
- Be wary of round numbers repeated across many articles with no primary source ("zombie statistics").

## 4. Checking technical claims and benchmarks
- Prefer official docs matching the version in use; check the docs version selector and "last updated" date. Confirm behavior in the changelog or source when critical.
- Benchmarks: who ran them, hardware, versions, workload realism, warmup, variance, whether the code is available, and whether the vendor tests only where it wins. Look for independent reproductions.
- Stack Overflow and blog answers age quickly; check dates, votes, and whether newer versions changed behavior.
- For security claims: cross-check CVE/NVD entries, vendor advisories, CISA KEV, the fixing commit, and affected version ranges; distinguish "vulnerable component present" from "exploitable in this configuration".
- For project health: last release date, commit activity, issue response times, number of maintainers, bus factor, funding, governance, and license changes.
- For AI model claims (capabilities, benchmarks, pricing, release status): use the provider's official pages and model cards; treat leaderboards and social posts as leads; note the date because these change fast.

## 5. Checking images, quotes, and viral claims
- Reverse image search (Google Lens, TinEye) for origin and earlier appearances; check metadata cautiously; look for signs of manipulation or AI generation.
- Verify quotes in original transcripts, video, or publications; watch for truncation that changes meaning and for misattribution.
- Check dates and locations: old footage reused for new events is common.
- Look for fact-checks from established organizations; read their reasoning rather than only the verdict.

## 6. Source type notes
| Type | Best for | Watch for |
|---|---|---|
| Official docs, specs, RFCs | Exact behavior and definitions | Docs lag behind code; version mismatch |
| Source code, tests, changelogs | Ground truth of behavior | Needs interpretation; branches differ |
| Peer-reviewed papers | Scientific evidence | Paywalls, small samples, publication bias, hype in abstracts |
| Preprints (arXiv, bioRxiv, SSRN) | Cutting-edge work | Not peer reviewed; may change or be withdrawn |
| Government data and legislation | Official numbers, legal text | Definitions, revision dates, jurisdiction |
| News reporting | Events and context | Speed vs accuracy, editorial slant, reliance on press releases |
| Analyst and consulting reports | Market sizing, trends | Methodology often opaque; paywalled; vendor-funded |
| Company blogs and docs | Product details | Marketing framing; selective benchmarks |
| Community (forums, Reddit, X, HN, Discord) | Real-world experiences, edge cases | Anecdotal, unverified, pseudonymous, brigading |
| Wikipedia | Orientation, references list | Not a citable end source; follow references |
| AI-generated summaries | Leads only | Hallucinated facts and citations; verify every claim |

## 7. Search operators and tactics
- Exact phrase: `"connection reset by peer"`; exclude: `-jobs`; site: `site:docs.python.org asyncio`; file type: `filetype:pdf`; title: `intitle:`; URL: `inurl:`; date restriction through tools or by adding the year.
- Use the vocabulary experts use; find a key term then search with it. Try both formal and colloquial names, acronyms and expansions, and other languages for regional topics (Arabic, French, Spanish, etc.) since original sources may not be in English.
- Search for the **opposite** claim too ("X does not work", "X criticism", "X vs alternative", "X problems") to avoid confirmation bias.
- For software: search `<library> <version> breaking changes`, `<library> github issues <symptom>`, `<library> security advisory`.
- For papers: search title in quotes; check "cited by"; use "related articles"; look for survey papers to map a field fast.
- Use Wayback Machine for removed or changed pages; note archive dates.
- Follow the reference lists of good sources ("citation chaining") and use the "Sources" or "Further reading" sections.
- When results are thin, change the angle: a different vocabulary, a different source type, a narrower sub-question, or the specific dataset/repository/agency likely to hold the data.

## 8. Citation hygiene
- Cite what you read, where you read it. Include: author or organization, title, publisher/site, publication or update date, URL, and access date for volatile pages.
- Prefer stable identifiers (DOI, arXiv id, RFC number, version-tagged docs URL, commit hash or permalink).
- Cite the primary source for the claim rather than a secondary summary when both are available; if you only saw the secondary, cite it and say so.
- Never fabricate DOIs, page numbers, quotes, or authors. If a detail could not be verified, omit it or mark it as unverified.
- Keep quotations short and exact; paraphrase everything else.

## 9. Common failure modes
- Trusting the first page of results or SEO-optimized content farms
- Stopping when a source agrees with your expectation
- Treating repetition across sites as independent confirmation (they often cite one origin)
- Using outdated versions of docs, laws, prices, or benchmarks
- Mixing definitions or time periods when comparing numbers
- Relying on model memory for facts that can change, instead of searching
- Overstating certainty in the final write-up
