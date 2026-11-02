# search-loop

One shared search growth engine for every selling site. Each site runs the same loop, at $0:

1. **FIND** (weekly) — searches the site can win: its own Search Console rows at positions ~8–30, Google and Bing autocomplete seeded from measured queries and topic seeds, question expansions, Bing Webmaster keyword data when a key exists, local question sets when the site is local. Scored "easy to win" from free signals only. Same-intent variants ("overcome / avoid / stop X") become one target. A free-model screen drops searches that belong to another meaning or brand. Never paid or grounded model calls, never SERP scraping. A signal that could not be read is written `not read: <reason>`.
2. **BUILD** (daily) — one page per easy search: direct answer first, sourced facts (each source URL must answer 200), FAQ, structured data, internal links, a "Related questions" block placed on relevant existing pages (so no new page is an orphan), and it ends in the site's one action. **Published straight away** once it passes the gate.
3. **CHECK + REPAIR** — every page at 2, 4 and 8 weeks and 90 days: Search Console clicks/position, index status, AI-referral visits (referrer hostname only) and AI-bot hits where Cloudflare analytics is readable. Winners seed more pages on their topic; pages near page 1 are strengthened with a before/after hash and **undone automatically** if they get worse; 90 days with no impressions → merged into a stronger page with a 301 (logged in `consolidation-ledger.json`).
4. **REPORT** — every run uploads the Actions artifact **`search-loop-week`** (schema [`search-loop-week-v1`](schema/search-loop-week-v1.json)).

## The global switch (normal | slow | off)

One repository variable on this repo throttles every site at once — no site repo is touched:

```sh
gh variable set SEARCH_LOOP_MODE --body slow -R seq23/search-loop
```

| Mode | FIND | BUILD | CHECK + REPAIR | Strengthening rewrites |
|---|---|---|---|---|
| `normal` | weekly | site pace (10/day start, up to 30) | daily | yes |
| `slow` | weekly | max **3 pages/site/day** | weekly | no (undo and merge only) |
| `off` | — | — | CHECK + report still run; the report says **"Search loop is switched off (mode=off)"** | no |

- `mode-sync.yml` mirrors the variable into [`control/mode.json`](control/mode.json) hourly; every site run reads that file, so a flip lands within the hour. To apply it now: `gh workflow run mode-sync.yml -R seq23/search-loop`.
- A site's own `mode` in its config may only **lower** the global mode, never raise it.
- If the switch cannot be read, the run uses `slow` and says so (`NAMED NOTE [MODE_UNREAD]`); it never fails open to `normal`.
- If a site's free model route is rate-limited or exhausted, that run drops itself to `slow` for the day with `NAMED NOTE [FREE_MODEL_RATE_LIMITED]` instead of failing.

## The quality gate (before anything is published)

Her search-readiness checklist (boss-os `src/shared/boss/searchReadiness/checklist.json`), every-page items: title 30–65 chars with the search first and the site name once (b1, b10); meta description 120–160 (b2); one H1 (b3); a 40–60 word "X is …" answer under the H1 (b4); one FAQPage, 3–6 visible questions with 40–60 word answers (b5); complete social tags with a 1200×630 image (b6); descriptive anchors and image alt text (b8); 600+ words (b9); visible published date (d4). Plus: at least one fact whose source answers 200; no unsourced statistics, invented people, quotes, credentials, reviews or ratings; links only to the site's allowed targets (and verified sources); ends in the site's one action; not a near-duplicate of any existing page (5-word shingle Jaccard < 0.35). With `health_gate: health | dental`: no outcome or treatment claims, never "painless", no medical advice, no hours or services beyond the site's `health.real_facts`. A failed draft gets one fix attempt, then it is dropped (and not retried for 28 days) — never published thin.

## The free model lanes ($0 only)

Every site shares the same free capacity, so the engine spreads the load over three lanes and never pays:

| Order | Lane | Credential | How it stays $0 | When it closes for the run |
|---|---|---|---|---|
| 1 | **Gemini API free tier** (`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-flash`; each model has its own free daily quota; a model answering 404/400 is skipped for the run) | `GEMINI_API_KEY` (caller passes it in `secrets:`) | key from a Google AI Studio project with **no billing account** — the free tier cannot be charged | key refused; a model's daily quota closes that model, both → lane closed |
| 2 | **OpenRouter `:free`** (site roster + engine roster, dead ids excluded) | `OPENROUTER_API_KEY` | only `:free` models priced 0/0; a non-zero `usage.cost` fails loud | key refused, `free-models-per-day` used up |
| 3 | **Cloudflare Workers AI** (`@cf/google/gemma-4-26b-a4b-it`, thinking off) | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (reads today's usage: Account Analytics) + `CLOUDFLARE_WORKERS_AI_TOKEN` (runs the model; falls back to `CLOUDFLARE_API_TOKEN`) | metered: reads today's usage from Cloudflare analytics before every call; stops at 600 neurons/day of its own model and when the whole account passes 9,000 of the free 10,000 (studios hold 8,500); **fails closed** if usage cannot be read | share used, usage unreadable |

- GitHub Models was retired by GitHub on 30 Jul 2026 and is no longer a lane (v1.2.2). Any lane whose endpoint answers HTTP 200 without JSON is closed for the run.
- Per-minute 429s back off (up to 3 rounds, ≤ 6 minutes of waiting) and retry across lanes before giving up.
- **Time limits (never a hang):** each model request 90 s (OpenRouter is asked with reasoning off: thinking models given `effort: low, exclude` spent the whole token budget on hidden reasoning and timed out, measured 2 Nov 2026); each model call (all lanes, models and backoff) 4 min; a model that times out is skipped for the rest of the run. Every other request (sources, Search Console, Cloudflare, IndexNow, autocomplete) has a timeout and at most one retry. The run has a **soft budget** of 35 min after the stagger (`SEARCH_LOOP_SOFT_MINUTES`): nothing new starts after it, the run writes its report and commits what it has (`NAMED NOTE [RUN_TIME_BUDGET]`, searches stay queued). A **watchdog** at 55 min (`SEARCH_LOOP_HARD_MINUTES`) ends a stuck run with `NAMED STOP [RUN_HUNG]` naming the stage; the job itself times out at 100 min. `progress +Nm <stage>` lines show where time goes.
- When every lane is out: the run drops to `slow` for the day (`NAMED NOTE [FREE_MODEL_RATE_LIMITED]`), the search stays queued for the next run (never dropped), and the report names each closed lane. If BUILD then published nothing because of the lanes (a search left unanswered, or BUILD ended early on them; drafts that answered and failed the gate are the gate's `BUILD published 0` note instead), the run writes **`NAMED NOTE [NO_FREE_MODEL]`** (job summary and the weekly report's notes; exit 0, because the next run retries the queued searches) and counts the streak in `runs.json` (`no_free_model`). It goes red with **`NAMED STOP [NO_FREE_MODEL]`** (exit 2; report, checks and ledger still commit) on the **3rd such run in a row or once the streak is 24 h old**, whichever comes first. Any run whose lanes answer ends the streak.
- **Stagger:** a scheduled run waits a fixed, site-specific 0–39 minutes (hash of `site`) before starting, so sites do not hit the shared lanes together; also give each caller its own cron minute. `llm.stagger: false` turns it off; dispatched runs never wait.

## Pace

Starts at `pace.start_per_day` (10). Once a week: if more than half of the pages 14–42 days old are indexed (Search Console URL Inspection, free), +5/day up to the cap (30); otherwise halved. If indexing cannot be read, the pace holds. Every change is logged with its reason in `pace.json`.

## How a site adopts it

1. **Config** — add `search-loop.config.json` at the repo root ([full example](examples/search-loop.config.json)):

| Key | Required | What it is |
|---|---|---|
| `schema` | yes | `"search-loop-config-v1"` |
| `site`, `base_url`, `site_name` | yes | id, `https://host` (no trailing slash), the brand every title names |
| `audience`, `voice`, `topics[]` | yes | from the site's brain (`~/Brains/<slug>.md`) |
| `action.label`, `action.url` | yes | the site's one action; every page ends in it |
| `allowed_link_targets[]` | yes | origins pages may link to (e.g. velocity → canonical) |
| `output.dir`, `output.format`, `output.url_prefix` | yes | where pages go: `dir-index` (`x/index.html`) or `html-file` (`x.html`) |
| `output.redirects` | no | where merges write their 301: `{file:"_redirects", format:"lines"}` (default) or a JSON list (`format:"json-list"`, `list_key`, `source_field`, `source_form: rel\|route`, `target_field`, `extra`, `count_key`) |
| `mode` | no | `normal` (default), `slow`, `off` — can only lower the global switch |
| `pace` | no | `start_per_day` 10, `step_per_week` 5, `cap` ≤ 30, `min_per_day` 2 |
| `menu_pages_need_approval` | no | `true` = never edit menu pages (`menu_pages[]` or the homepage `<nav>` links) |
| `menu_pages` | no | explicit list of menu routes |
| `health_gate` | no | `none` (default), `health`, `dental`; with `health.real_facts` `{services[], hours}` |
| `protected_paths[]` | no | files/dirs the engine never edits (e.g. a protected sales page) |
| `shares_audience_with[]` | no | `{site, ledger_url \| ledger_path}` of sibling sites; two sites never target the same search |
| `local` | no | `{city, neighbourhoods[]}` adds local question sets |
| `publisher` | no | `{name, url}` for Article author/publisher (an organization; never an invented person) |
| `template` | no | `stylesheets[]`, `og_image{url,width,height}`, `header_html`, `footer_html`, `section_name` |
| `related` | no | `max_pages_per_new_page` (2), `scan_dirs[]`, `skip_dirs[]` |
| `find` | no | `gsc_position_min` 8, `gsc_position_max` 30, `max_autocomplete_calls` 80, `max_targets` 200, `exclude_words[]` |
| `gsc` | no | `site_url` or `site_url_env` (default env `GSC_SITE_URL`) |
| `llm.routing_file` | no | the site's own $0 routing file (OpenRouter `:free` models); default [`config/free-models.json`](config/free-models.json) |
| `indexnow` | no | `{key, key_location}` — the key the site already serves |
| `analytics` | no | `ai_referrals` / `ai_bot_hits`: `cloudflare` (+ `zone`) or `none` |
| `conversions.source` | no | `none` → the report says `not read` |
| `ledger_dir` | no | default `data/search-loop` |

2. **Caller workflow** — `.github/workflows/search-loop.yml` in the site repo:

```yaml
name: Search Loop
on:
  schedule:
    - cron: "41 11 * * *"
  workflow_dispatch:
permissions:
  contents: write
  actions: write
concurrency:
  group: search-loop
  cancel-in-progress: false
jobs:
  loop:
    uses: seq23/search-loop/.github/workflows/search-loop.yml@v1
    with:
      engine_ref: v1
    secrets:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      GSC_SERVICE_ACCOUNT_JSON: ${{ secrets.GSC_SERVICE_ACCOUNT_JSON }}
      GSC_SITE_URL: ${{ secrets.GSC_SITE_URL }}
      BING_WEBMASTER_API_KEY: ${{ secrets.BING_WEBMASTER_API_KEY }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      CLOUDFLARE_WORKERS_AI_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_AI_TOKEN }}
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}   # no-billing project only
```

Optional inputs: `setup_command` (e.g. `npm ci --ignore-scripts`), `post_build_command` (the site's own build that folds new pages into sitemaps — runs only when pages were published), `commit_command` (the site's own commit helper), `node_options`, `stage`, `config`. Only the default branch publishes; a run on any other branch is a **proof run** (builds, gates, reports, uploads the pages as `search-loop-pages`, commits nothing). Add `.search-loop-engine/` and `.search-loop-run.log` to the site's `.gitignore`.

3. **Secrets** — all optional; a missing one is a `NAMED STOP [SECRET_MISSING_…]` line and the stages that need it write `not read`. No paid key is ever used: the model route is $0-only (`max_cost_usd: 0`, `fallback_to_paid: false`, a non-zero `usage.cost` fails loud).

4. **Ledger** (committed to the site under `ledger_dir`): `targets.json`, `discovery-receipt.json` (every host called, cost 0), `pages.json` (every page, checks, strengthen hashes), `drafts/`, `snapshots/` (pre-strengthen bytes for undo), `pace.json`, `consolidation-ledger.json`, `winners.json`, `ai-daily.json`, `runs.json`, `search-loop-week.json`.

## Exit codes and Rule 0

`0` work done and visible · `1` problems (bad config, bad report) · `2` `NAMED STOP [NOTHING_DONE]` — nothing found, built or checked · `3` model key missing/refused with nothing else done · `9` push failed: `NAMED STOP [PUSH_CONFLICT]` (a real conflict outside the ledger) or `NAMED STOP [PUSH_FAILED]` (five refused pushes). The default commit step (`bin/commit-push.mjs`) fetches and rebases onto the moved default branch and retries with jitter, merging the engine's own ledger JSON by record key, so another job pushing to main meanwhile is never a failure. Every run ends with a census line.

## Develop

```sh
npm run check        # validator + its self-test, unit tests, engine --self-test
node bin/search-loop.mjs run --config search-loop.config.json --stage find   # in a site checkout
```

Releases: semver tags `v1.x.y` plus the moving `v1` tag that callers pin.
