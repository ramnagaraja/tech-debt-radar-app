# Tech Engineering Debt Radar

Point it at one or more related codebases and, optionally, one or more
databases. It analyzes all of them together, builds one combined code + data
dependency graph, and gives you heatmaps, an interactive graph, and AI
guidance grounded in the real metrics — now optionally enriched with Jira/
Confluence context, and extended to critique SOLID/design-pattern/reusability
concerns with concrete code-level fixes, not just complexity/security/design
smells.

## Run it

```bash
cd backend
pip install -r requirements.txt
python3 app.py
```

Open **http://localhost:8000**, run an analysis, then click the gear icon in
the header to set up an AI provider (Claude, Gemini, or Sarvam AI) under
**Admin**. Nothing else needs configuring — no environment variables required.

**Codebase tech**: Python (radon + bandit + ast) or .NET/C# (a bundled
Roslyn-based analyzer under `backend/dotnet_tools/CodeMetrics`) — pick one or
leave it on Auto-detect. The .NET path needs the **.NET SDK** installed and
on `PATH`, and the target repo's packages already restored
(`dotnet restore`), since it does real semantic analysis via MSBuildWorkspace
rather than text/regex heuristics.

**Database**: Postgres, MySQL/MariaDB, or SQL Server for a live connection
(dialect is read from the connection string itself, e.g.
`postgresql://...`, `mysql+pymysql://...`, `mssql+pyodbc://...` — SQL Server
also needs an ODBC driver, e.g. "ODBC Driver 18 for SQL Server", installed on
the host), or any of the three for a `.sql` schema file (pick the dialect
explicitly there, since a file doesn't self-identify one).

**Multiple repos and databases**: add as many of each as you like in Setup.
Repo/DB paths can be local or a network path (UNC, e.g.
`\\fileserver\share\backend`, or a mapped drive) — no special configuration
needed, it's just a filesystem path either way. With exactly one repo or one
DB, ids stay exactly as they are today (`app.py`, `orders`); with more than
one, everything is namespaced by display name (`api/app.py`,
`orders-db.orders`) so nothing collides in the combined view. This is also
what makes cross-repo duplicate-code detection and cross-repo/cross-DB
code-to-table links possible.

**Project context — Jira & Confluence** (optional, best-effort): add Jira
issue/project links or Confluence page links in Setup, and set one Atlassian
email + API token (from id.atlassian.com — the same pair authenticates both
Jira Cloud and Confluence Cloud) once under **Admin**. Fetched text is fed
into the AI's context for the Ask tab and recommendations. A fetch failure
(bad credentials, unreachable host, unparseable URL) degrades gracefully —
you'll see the error inline rather than the whole analysis failing.

## What's in this version

* **Code heatmap** — grouped by folder, colored by debt score.
* **DB heatmap** — same idea for database tables. If you skipped the database
step during setup, this tab explains that plainly instead of just vanishing.
* **Combined dependency graph** — every file and table together: circles are
files, squares are tables, edge color shows the relationship type (import,
foreign key, or code-referencing-table). Drag, zoom, click to focus.
* **DB-only dependency graph** — the same graph filtered to just tables and
foreign keys, for a clean view of the data model on its own.
* **"Color by" toggle** on both graphs — switch between overall debt, design
concerns, or security concerns to see where each specific kind of risk
concentrates.
* **Ask tab** — structured, markdown-formatted answers (headings, tables,
lists), grounded only in the actual computed metrics.
* **On-demand recommendations** — click any node in a graph, then "Get
recommendations" for a structured, specific remediation writeup. For code
files, the model is given the file's real source (not just metrics), and is
asked specifically for a SOLID-principle/design-pattern critique and
reusability/duplication concerns — with concrete before/after code
suggestions grounded in the actual lines, not generic advice.
* **Confidence badges** — every AI answer ends with a self-reported
High/Medium/Low confidence line, parsed out and shown as a badge rather than
buried in the text. This is the model assessing how directly its own answer
is supported by the data it was given — not a statistical probability.
* **Feedback loop** — thumbs up/down are persisted to the app's own database.
Recent down-voted answers are automatically included in future prompts as
"avoid repeating this" examples. This is real and it runs every time you use
the Ask tab — but it's in-context conditioning, not gradient-based
reinforcement learning; no model weights are ever updated.
* **Info icons** on every metric line item and every score-breakdown
component, explaining exactly what it measures and how it's computed.
* **Multi-provider AI** — Claude, Gemini, or Sarvam AI, switchable from
Admin. Gemini and Sarvam are both called through their OpenAI-compatible
endpoints.

## Debt score, in full

**Code**: 35% complexity + 20% churn (git history) + 25% security (bandit
for Python, a Roslyn semantic-analysis pass for .NET — both weighted by
severity and confidence) + 20% design (maintainability index, long
functions, deep nesting, too many parameters, oversized files, duplicate/
near-duplicate code, high public surface, long if/switch chains). Both
languages feed the exact same scoring math
(`backend/code_analyzers/scoring.py`), so files are directly comparable
across a mixed codebase — and, with multiple repos, across all of them at
once (scoring runs once on everything combined, not once per repo, which is
also what makes cross-repo duplicate detection possible).

The three newest design signals are deliberately *checkable*, not a stand-in
for full SOLID analysis: **duplicate code** hashes every function's
structure (identifiers/literals blanked out) and flags any hash matching
elsewhere in the run — a real reusability signal, catching copy-paste even
across repos; **high public surface** is a coarse single-responsibility
proxy (lots of public functions in one file); **long conditional chains**
flags `if/elif`/`switch` chains over 5 branches — a classic
open/closed-principle smell. Deeper SOLID/LSP/ISP/DIP reasoning needs
type-hierarchy judgment that isn't reliable to approximate generically
across languages — that's exactly what the source-grounded "Get
recommendations" call does instead, on demand, per file.

**Database**: 30% performance (foreign keys with no covering index) + 15%
size + 30% security (sensitive-looking column names, broad write grants —
PUBLIC on Postgres/SQL Server, a wildcard-host grant as the closest MySQL
equivalent) + 25% design (missing primary key, `\*\_id` columns with no real
foreign key, table width).

Every one of these sub-scores is visible in the app — click "How is this
score calculated?" on any file or table's detail panel.

## Known gaps, honestly

* **The .NET path needs the repo to build.** Unlike the Python path (which
  works on source alone), the Roslyn analyzer opens the real
  `.sln`/`.csproj` via MSBuildWorkspace, so `dotnet restore` must succeed
  against the target repo first. If no project can be loaded, the analysis
  fails with a clear error rather than silently degrading.
* **Only modern SDK-style .NET projects are supported** — `.NET Core`, `.NET
  5` and later, anything with `<Project Sdk="Microsoft.NET.Sdk...">` at the
  top of its `.csproj`. Classic, pre-2017-style full-.NET-Framework projects
  (old ASP.NET MVC/Web Forms apps with `packages.config` and
  `<TargetFrameworkVersion>`) need a full Visual Studio MSBuild install to
  evaluate at all, which the cross-platform .NET SDK can't provide — the
  analyzer detects this and fails with a clear message rather than a raw
  MSBuild exception. If a machine also has Visual Studio/Build Tools
  installed alongside the .NET SDK, the analyzer explicitly prefers the SDK's
  own MSBuild to avoid a similar (harder to diagnose) version mismatch.
* **MySQL's "public grant" signal is an approximation.** MySQL has no literal
  PUBLIC role; a wildcard-host (`'user'@'%'`) grant is used as the closest
  proxy for "broadly writable." Postgres and SQL Server both have a real
  PUBLIC/public role, so those two are exact.
* **Cross-repo code-import edges aren't detected.** With multiple repos, each
  one's import/dependency graph is still built from its own source only — a
  shared library imported by two of your repos won't show as an edge between
  them. Cross-repo *duplicate-code* detection is separate and does work
  across repos (see above); cross-repo/cross-DB *code-to-table* edges also
  work, since that's a text-search over every repo's source against every
  table's bare name, not an import-graph question.
* **Jira/Confluence fetching is unverified against a real Atlassian Cloud
  site** — it was built and tested against synthetic ADF/storage-format
  fixtures and graceful-failure paths (bad URL, unreachable host), but not a
  live instance. Try it against yours and expect to iterate on the URL
  patterns it recognizes.
* **`/api/file-source` (used for source-grounded recommendations) is backed
  by an in-memory map rebuilt on every analysis** — restarting the backend
  without re-running an analysis means recommendations fall back to
  metrics-only until the next run.
* **No trend history** — each analysis run overwrites the last.
* **The feedback loop is in-context, not gradient-based.** If you want actual
prompt/weight optimization from accumulated feedback (e.g. a DSPy-style
optimizer), that's a real additional build, not something to assume is
already happening.
* **Single-job, single-user** — one analysis runs at a time, in-memory job
status.
* **API keys are stored in this app's own local SQLite database** (via
Admin), in plain text, on whatever machine runs the backend. Fine for a
personal or team laptop; don't expose this server to the open internet
as-is.

