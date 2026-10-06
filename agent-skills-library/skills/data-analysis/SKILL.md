---
name: data-analysis
description: Performs and reviews data analysis end to end: framing the question, profiling and cleaning data, exploratory analysis, choosing statistical methods, building SQL, pandas, or Polars pipelines, creating honest visualizations, validating results, and communicating findings and limitations. Use whenever the user provides a dataset (CSV, Excel, JSON, database), asks for insights, metrics, KPIs, dashboards, A/B test analysis, forecasting basics, statistical tests, charts, or data cleaning, and whenever an analysis needs to be checked for correctness.
license: MIT
metadata:
  category: data
  version: "1.0"
---

# Data Analysis

Good analysis answers a decision-relevant question correctly and communicates what the data can and cannot support.

## 1. Workflow

1. **Frame the question.** What decision will this inform? Define the metric precisely (numerator, denominator, time window, filters, unit of analysis). Write the hypothesis or the specific question. Agree on success criteria before touching data.
2. **Understand the data.** Source, collection method, grain (what does one row represent?), time coverage, keys, known quirks, definitions, refresh cadence, owners. Read the data dictionary or ask.
3. **Profile and validate.** Row and column counts, dtypes, missing values, duplicates, ranges, cardinality, distributions, outliers, impossible values, date parsing, encoding, join keys. Check totals against a trusted source.
4. **Clean transparently.** Every change is code, not manual edits; keep raw data untouched; log the rules and the rows affected.
5. **Explore.** Univariate distributions, bivariate relationships, segments, time trends, seasonality, cohorts. Generate hypotheses; do not treat exploration as confirmation.
6. **Analyze.** Choose methods that match the question and data (see section 4). Quantify uncertainty.
7. **Validate.** Sanity checks, reconcile with independent numbers, test on holdout or subsamples, examine sensitivity to assumptions and outlier handling, have someone replicate.
8. **Communicate.** Lead with the answer, show evidence, state limits and next steps (section 7).
9. **Make it reproducible.** Script or notebook that runs top to bottom, seeded randomness, pinned environment, documented data snapshot.

## 2. Profiling and cleaning checklist

- [ ] Grain confirmed; primary key unique (`df.duplicated(subset=keys).sum() == 0`)
- [ ] Types correct: dates parsed with explicit format and time zone; numerics not strings; categories consistent (case, whitespace, spelling)
- [ ] Missingness understood: MCAR, MAR, or MNAR? Encoded as blanks, `0`, `-1`, `N/A`, `9999`? Decide: drop, impute, flag, or model explicitly. Never silently fill with zero.
- [ ] Duplicates: exact vs near duplicates; which record wins and why
- [ ] Outliers: error, rare-but-real, or important signal? Keep a flag; report results with and without
- [ ] Units and currencies consistent; inflation adjustment if comparing across years
- [ ] Join hygiene: check row counts before and after joins; look for many-to-many explosions and unmatched keys (`validate="one_to_one"` in pandas)
- [ ] Time: time zones, daylight saving, incomplete latest period (exclude partial days/weeks/months from trends), late-arriving data
- [ ] Filters and exclusions documented (test accounts, internal users, bots, refunds)
- [ ] Personal data minimized, pseudonymized, and handled under policy

## 3. Tooling idioms

### pandas
```python
import pandas as pd
df = (pd.read_csv("orders.csv", parse_dates=["created_at"], dtype={"customer_id": "string"})
        .rename(columns=str.lower)
        .assign(revenue=lambda d: d.qty * d.unit_price)
        .query("status != 'test'"))
assert df["order_id"].is_unique
monthly = (df.set_index("created_at")
             .resample("MS")
             .agg(orders=("order_id", "nunique"), revenue=("revenue", "sum")))
```
Use vectorized operations, method chaining, `groupby(...).agg(named=...)`, `merge(..., validate=...)`, categorical dtypes for low-cardinality columns, and avoid `iterrows`/row-wise `apply`. Use `df.info(memory_usage="deep")`, `df.describe(include="all")`, `df.isna().mean()`.

### Polars (larger or faster workloads)
```python
import polars as pl
out = (pl.scan_csv("orders.csv").filter(pl.col("status") != "test")
         .group_by(pl.col("created_at").dt.truncate("1mo"))
         .agg(pl.len().alias("orders"), (pl.col("qty") * pl.col("unit_price")).sum().alias("revenue"))
         .sort("created_at").collect())
```
Lazy evaluation and streaming handle data larger than memory; DuckDB is excellent for SQL over local files (`duckdb.sql("select ... from 'data/*.parquet'")`).

### SQL patterns
```sql
-- cohort retention with CTEs and window functions
WITH first_order AS (
  SELECT customer_id, MIN(order_date) AS first_date
  FROM orders GROUP BY customer_id
), activity AS (
  SELECT o.customer_id,
         DATE_TRUNC('month', f.first_date) AS cohort,
         DATE_DIFF('month', DATE_TRUNC('month', f.first_date), DATE_TRUNC('month', o.order_date)) AS month_n
  FROM orders o JOIN first_order f USING (customer_id)
)
SELECT cohort, month_n, COUNT(DISTINCT customer_id) AS active
FROM activity GROUP BY 1, 2 ORDER BY 1, 2;
```
Habits: name CTEs by meaning; check join fan-out with counts; use `COUNT(DISTINCT ...)` deliberately; filter early; avoid `SELECT *`; window functions (`ROW_NUMBER`, `LAG`, `SUM() OVER`) for rankings, deltas, and running totals; use `NULLIF` for safe division; handle time zones explicitly.

### Notebooks to scripts
Explore in notebooks; move stable logic into tested modules; keep notebooks as reports that call functions; clear outputs before committing (or use `nbstripout`); run end-to-end before sharing (`Restart & Run All`).

## 4. Choosing methods

| Question | Typical approach | Notes |
|---|---|---|
| Describe center and spread | Median, IQR, percentiles, mean + SD if roughly symmetric | Prefer medians and percentiles for skewed data (income, latency) |
| Compare two groups (numeric) | Welch t-test, or Mann-Whitney U if non-normal/ordinal; bootstrap CI for the difference | Report effect size and CI, not just p-value |
| Compare proportions | Two-proportion z-test, Fisher exact for small counts, chi-square for tables | Check expected counts; correct for multiple comparisons |
| Compare 3+ groups | ANOVA/Kruskal-Wallis, then post-hoc with correction | Or fit a regression with group terms |
| Association | Pearson (linear), Spearman (monotonic), Cramer's V (categorical) | Correlation is not causation; plot the data |
| Predict a number | Linear/regularized regression, gradient boosting | Validate out of sample; check residuals |
| Predict a class | Logistic regression, tree ensembles | Handle imbalance; use PR curves; calibrate |
| Time series | Decompose trend/seasonality; baseline (seasonal naive); ETS/ARIMA/Prophet-style; ML with lag features | Split by time, never randomly; evaluate on rolling origin |
| A/B test | Pre-specified metric, sample size/power, randomization check, CUPED or stratification if helpful, sequential testing if peeking | Watch sample ratio mismatch, novelty effects, multiple metrics |
| Causal effect (observational) | Diff-in-diff, regression with controls, matching/IPW, instrumental variables, regression discontinuity | State assumptions explicitly; sensitivity analysis |
| Segmentation | k-means/GMM/hierarchical on scaled features; RFM for customers | Validate that clusters are stable and actionable |

Statistical hygiene:
- Decide the test and threshold **before** looking at outcomes; correct for multiple comparisons (Bonferroni/Holm/Benjamini-Hochberg) when checking many hypotheses.
- Use confidence or credible intervals to show uncertainty; distinguish statistical from practical significance.
- Check assumptions (independence, variance, distribution, sample size), and use robust or non-parametric options when violated.
- Avoid p-hacking, HARKing, and stopping experiments when the p-value dips below 0.05.
- Beware Simpson's paradox: aggregate trends can reverse within segments; always check key segments.
- Beware data leakage in modeling (features that include the future or the label); split before preprocessing; use pipelines and cross-validation; keep a final untouched test set.

## 5. Common analytical traps

- **Survivorship and selection bias**: analyzing only customers who stayed or responded.
- **Base-rate neglect**: small percentages of large groups vs large percentages of small groups; show counts and denominators.
- **Average of averages** (Simpson's, weighting errors): recompute from underlying counts.
- **Cherry-picked windows** and incomplete periods.
- **Double counting** through joins or overlapping segments.
- **Comparing non-comparable groups** (different time, geography, definition).
- **Extrapolation** beyond the observed range.
- **Regression to the mean** mistaken for treatment effect.
- **Ecological fallacy**: inferring individual behavior from group data.
- **Metric gaming and Goodhart's law**: a target metric stops measuring what you care about.
- **Ignoring seasonality** and calendar effects (holidays, Ramadan, weekends, payday cycles, regional calendars).

## 6. Visualization principles

- Pick the chart for the question: **comparison** (bars, sorted), **trend** (lines), **distribution** (histogram, box/violin, ECDF), **relationship** (scatter with trend line), **composition** (stacked bars sparingly, treemap rarely), **ranking** (sorted horizontal bars), **geography** (choropleth with normalized rates).
- Avoid pie/donut with many slices, 3D effects, dual y-axes (misleading), rainbow palettes, and truncated bar axes (bars start at zero; lines may not).
- Show data honestly: label axes and units, include sample sizes and time ranges, show uncertainty bands, annotate key events, keep aspect ratios sane.
- Reduce clutter: remove chart junk, light gridlines, direct labels instead of legends when possible, consistent colors per category across charts.
- Color-blind-safe palettes (Okabe-Ito, ColorBrewer); do not rely on color alone; ensure sufficient contrast.
- Titles state the takeaway ("Repeat purchases fell 12% after the price change") with a subtitle for the definition.
- Right-to-left audiences: mirror axes and legends only when the whole layout is mirrored; keep numerals and labels readable; use fonts with proper Arabic support.
- Tools: matplotlib/seaborn/plotnine, Altair/Plotly for interactive, Vega-Lite, Observable, BI tools (Metabase, Superset, Power BI, Tableau, Looker).

## 7. Communicating results

Structure for stakeholders:
1. **Answer** (headline number, direction, magnitude, confidence)
2. **Why we believe it** (2 to 4 key charts or tables)
3. **Caveats** (data quality, assumptions, sensitivity, what was excluded)
4. **Recommendation / next steps** and what would change the conclusion
5. **Appendix**: methods, definitions, code/data links, reproduction steps

Write in the audience's language, not statistical jargon. Round sensibly and report ranges. Separate what the data shows from interpretation and opinion. Make dashboards purposeful: few KPIs, clear definitions, freshness stamp, owner, and drill-down paths.

## 8. Reproducibility and governance

- Version code and, where possible, data snapshots (DVC, lakeFS, dated Parquet); record the query and extraction time.
- Pin library versions; set random seeds; store parameters and config.
- Add data tests (pandera, Great Expectations, dbt tests) for schema, uniqueness, null rates, ranges, and referential integrity; monitor drift in pipelines.
- Document metric definitions in one place (semantic layer or metrics doc); avoid redefining metrics ad hoc.
- Respect privacy and ethics: minimize personal data, aggregate small cells, follow consent and retention rules, consider fairness across groups when results drive decisions.

## 9. Definition of done

- [ ] Question and metric definitions written down
- [ ] Data quality checked and issues documented
- [ ] Numbers reconcile with an independent source or sanity checks
- [ ] Methods justified; uncertainty quantified; multiple comparisons handled
- [ ] Charts honest and self-explanatory
- [ ] Findings, limitations, and recommendations stated plainly
- [ ] Code reruns end to end from raw data
