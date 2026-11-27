# search-loop

One shared search growth engine for every selling site. Each site runs the same loop, at $0:

1. **FIND** (weekly) — searches the site can win: its own Search Console rows at positions ~8–30, Google and Bing autocomplete seeded from measured queries and topic seeds, question expansions, Bing Webmaster keyword data when a key exists, local question sets when the site is local. Since v1.6.0 every search goes into one of **two lanes** (see "Two lanes: can be #1 now, and striking distance"): about 2 of every 3 new pages are searches the site can be #1 for straight away (a competition score), about 1 in 3 are searches it already ranks 8–30 for. Same-intent variants ("overcome / avoid / stop X") become one target. A free-model screen drops searches that belong to another meaning or brand. Never paid or grounded model calls, never SERP scraping. A signal that could not be read is written `not read: <reason>`.
2. **BUILD** (daily) — one page per easy search: direct answer first, sourced facts (each source URL must answer 200), FAQ, structured data, internal links, a "Related questions" block placed on relevant existing pages (so no new page is an orphan), and it ends in the site's one action. **Published straight away** once it passes the gate.
3. **CHECK + REPAIR** — every page at 2, 4 and 8 weeks and 90 days: Search Console clicks/position, index status, AI-referral visits (referrer hostname only) and AI-bot hits where Cloudflare analytics is readable. Winners seed more pages on their topic; pages near page 1 are strengthened with a before/after hash and **undone automatically** if they get worse; a page that ChatGPT, Gemini or Google AI Overviews leave out of their answer is strengthened first (v1.14.0, below); 90 days with no impressions → merged into a stronger page with a 301 (logged in `consolidation-ledger.json`).
4. **REPORT** — every run uploads the Actions artifact **`search-loop-week`** (schema [`search-loop-week-v1`](schema/search-loop-week-v1.json)).

## The global switch (normal | slow | off)

One repository variable on this repo throttles every site at once — no site repo is touched:

```sh
gh variable set SEARCH_LOOP_MODE --body slow -R seq23/search-loop
```

| Mode | FIND | BUILD | CHECK + REPAIR | Strengthening rewrites |
|---|---|---|---|---|
| `normal` | weekly | distinct pages only, under the site's cap (max 10/day) | daily | yes |
| `slow` | weekly | max **3 pages/site/day** | weekly | no (undo and merge only) |
| `off` | — | — | CHECK + report still run; the report says **"Search loop is switched off (mode=off)"** | no |

- `mode-sync.yml` mirrors the variable into [`control/mode.json`](control/mode.json) hourly; every site run reads that file, so a flip lands within the hour. To apply it now: `gh workflow run mode-sync.yml -R seq23/search-loop`.
- A site's own `mode` in its config may only **lower** the global mode, never raise it.
- If the switch cannot be read, the run uses `slow` and says so (`NAMED NOTE [MODE_UNREAD]`); it never fails open to `normal`.
- If a site's free model route is rate-limited or exhausted, that run drops itself to `slow` for the day with `NAMED NOTE [FREE_MODEL_RATE_LIMITED]` instead of failing.

## The quality gate (before anything is published)

Her search-readiness checklist (boss-os `src/shared/boss/searchReadiness/checklist.json`), every-page aims (which ones block is below): title 30–65 chars with the search first and the site name once (b1, b10); meta description 120–160 (b2); one H1 (b3); a 40–60 word "X is …" answer under the H1 (b4); one FAQPage, 3–6 visible questions with 40–60 word answers (b5); complete social tags with a 1200×630 image (b6); descriptive anchors and image alt text (b8); 600+ words (b9); visible published date (d4). Plus: at least one fact whose source answers 200, written by the model as a line the reader can act on, under a heading it writes in the page's voice (`facts_heading`; an older draft with none shows its sources below the FAQ under "Sources"); no unsourced statistics or prices (a money amount in digits or words outside the sourced facts; the site's own action label and `gate.own_prices` excepted), invented people, quotes, credentials, reviews or ratings; links only to the site's allowed targets (and verified sources); ends in the site's one action; not a near-duplicate of any existing page (5-word shingle Jaccard < 0.35). With `health_gate: health | dental`: no outcome or treatment claims, never "painless", no medical advice, no hours or services beyond the site's `health.real_facts`. 

**Problems vs notes** (her ruling, 2 Nov 2026: no petty validation). Before the gate, `render.mjs` fits the title (site name stripped from the lead and added once, a short lead falls back to the H1, a long one is cut at a word boundary to 65) and cuts the meta description to 160. Then only these **block**: anything invented (statistics, reviews, credentials, named people), health claims, link targets, unsourced fact lines, missing structure (H1, FAQPage, social tags, alt text, visible date, the action), leaked placeholders (`lorem ipsum`, `{{`, `[insert`, `as an AI`), near-duplicates, and a length floor missed by more than 25% (`FLOOR_SHARE` 0.75 in `gate.mjs`: title under 23 chars, meta under 90, answer under 30 words, FAQ under 3 questions, FAQ answer under 30 words, page under 450 words). Everything else is a **note** that never drops a page: over any length limit, under a floor by less than 25%, search-first title, site name once, the "X is …" answer, weak anchor text. No word list judges whether copy reads as machine-written: the model reviewer does that in context (v1.15.0). Notes are kept on the page in `pages.json` (`gate_notes`) and counted in the run notes. A failed draft gets two fix attempts (three tries in all), then it is dropped — never published thin. A drop whose every problem is fixable (a length floor, too few working sources, a malformed or missing model answer) is retried after 3 days, starting from last time's problems; after 3 drops of the same search, and for every other drop (off-audience, invented content, same intent), the wait is 28 days. A drop under an older `GATE_VERSION` is retried at once. On an English site (`language`, default `en`), a search clearly in another language is skipped, never queued (`skipped_language`). Links are checked in the page's `<main>` only (the site's own header/footer chrome never fails a draft), and hrefs are compared decoded (`&amp;` → `&`).

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
- When every lane is out: the run drops to `slow` for the day (`NAMED NOTE [FREE_MODEL_RATE_LIMITED]`), the search stays queued for the next run (never dropped), and the report names each closed lane. If BUILD then published nothing, the run writes **`NAMED NOTE [NO_FREE_MODEL]`** (job summary and the weekly report's notes; exit 0, because the next run retries the queued searches — never a red run) and counts the streak in `runs.json` (`no_free_model`); the note names it ("run N in a row since …"). Any run whose lanes answer ends the streak. Only a site with no model credential at all and nothing else done exits red (`NAMED STOP [FREE_MODEL_KEY]`, exit 3): retrying cannot fix a missing key.
- **Stagger:** a scheduled run waits a fixed, site-specific 0–39 minutes (hash of `site`) before starting, so sites do not hit the shared lanes together; also give each caller its own cron minute. `llm.stagger: false` turns it off; dispatched runs never wait.

## AI answer misses: fix the page first, write a new one only when none fits (v1.14.0)

Her words, 22 Nov 2026: "build the ai visibility loop ... make sure we close every gap in those screenshots". Boss OS reads, each week, the buyer questions where ChatGPT, Gemini or Google AI Overviews answer without the site, and serves them at `GET /api/boss/growth/ai-misses?host=<bare host>` (Bearer `BOSS_OPEN_LOOPS_TOKEN`, the secret callers already pass; the workflow hands it to the `Run the search loop` step only). Code: `src/ai-misses.mjs`, used before FIND and inside CHECK.

- **A miss naming an engine page** (`page_url` on the site's host, one of the engine's live question pages) strengthens that page: the questions and the sources the AI answers cited are the brief, in place of Search Console queries. There is **no Search Console position gate**, but the same page gate, before-hash snapshot and automatic undo as every strengthen. At most one strengthen per page per 14 days and 3 a run. It settles at 14 days or more once Boss OS has read a newer week: not listed any more -> `verdict.kept: "ai_miss"`; still listed -> `kept: true` with `still_missed`. No newer read in 28 days -> settled as not read, so a page with no Search Console data is never stuck (refresh takes it again 30 days after the strengthen). An AI-miss strengthen never uses up the page's one Search Console strengthen.
- **A miss naming another page** of the site (not an engine page) is skipped as `not an engine page`; the page is never touched. **A miss with no page** (`page_url: null`) becomes a FIND search that week (FIND runs again for it), is screened and ranked first, and BUILD takes it before any other, under the same cap, distinct gate and page gate. A same-intent engine or site page makes it a skip with that reason.
- **One action per miss id per Boss OS week** (`ai-misses.json` in the ledger): strengthened, a new candidate, or a skip that will not change this week (not an engine page, frozen, added nothing, failed the gate). A skip a later run could clear (mode slow or off, a strengthen still settling, the run limit, no free model) is reported but not recorded, so the next run acts.
- **Nothing new, nothing changed**: a strengthen whose model output only repeats headings or questions the page has leaves the page, its draft and its dates as they were (R-ADV-12). This also holds for the Search Console strengthen from v1.14.0 on.
- **A page edited by hand is never re-rendered** (strengthen, refresh and reshape alike): a re-render starts from the saved draft, so when the page's H1, lead, section headings, paragraphs, bullets or FAQ differ in their words from the draft (`draftDrift`), the page is left exactly as it is and the reason is recorded (`the page was edited after its draft was saved ...`). Layout, dates, sources and related links are not compared. Found on the keepmyproof proof run, 22 Nov 2026: a hand fix (#46) had corrected a recording-law sentence in the page only, and a re-render from the draft put the wrong sentence back. On 22 Nov 2026, 22 of the 85 live pages on the five callers differ from their drafts this way (keepmyproof 10, peace-be-still 10, approvalprep 2). Related links in either form (`data-search-loop="related"` or the marked block BUILD adds when a newer page links back) are carried into every re-render; the marked block was dropped before.
- **Every row is checked as if it lies**: an id that is not sha1 hex or appears twice, a lane other than `own`, a prompt under 8 or over 300 characters, or a `page_url` on another host or port, with credentials, dot segments, encoded dots or slashes or backslashes is rejected, counted, and never fetched or edited. At most 100 misses a read.
- **Could not tell is never "no misses"**: no token, a timeout, 401/403, 404, 5xx, a redirect (never followed, so the token goes nowhere else), a body that is not JSON, names another host or week, or `status: not_read` leaves the run going as before; the week report says `ai_misses.read: "not read: <reason>"` and counts it in `could_not_tell`.
- **Frozen sites** (Horse, Hicks): every miss is recorded as skipped, nothing is strengthened, and FIND is not re-run for it.
- **Report**: the week report gains an optional `ai_misses` block (additive; older readers ignore it): `read`, `week`, `misses`, `strengthened` (`[{id, page_url, at}]`, last 7 days), `new_candidates`, `skipped`, `rejected`, `could_not_tell`. The run line gains `ai_misses=<n>/strengthened:<n>/new:<n>/skipped:<n>/rejected:<n>` or `ai_misses=could_not_tell`. A proof run may point the reader at a fixture with `SEARCH_LOOP_AI_MISSES_URL`, honoured only for `http://127.0.0.1` or `http://localhost`.

## Comparison searches first (v1.16.0)

People choosing between options ("x vs y", "alternatives to x", "x instead of y", "better than", "switch from") are the buyers. FIND makes one more Search Console pull (`src/gsc.mjs` `COMPARISON_REGEX`, sent as a `query` `includingRegex` filter, so Search Console does the matching): `\b(vs|versus|compare|compared|comparing|comparisons?|alternatives?|competitors?|instead of|replacements?|better than|difference between|switch from|switching from)\b`, last 28 days, any position from `find.gsc_position_min` down (a row the site already ranks above that is left alone). The regex only decides which rows to ask for: the free-model relevance screen also answers which kept queries are real comparisons (`"testosterone replacement therapy"` matches the regex and is not one), and only those get `comparison: true`. Build order: AI answer misses, then comparisons, then priority topics, then the rest (FIND's list and BUILD's queue alike); pages keep `comparison: true` in `pages.json`.

- A row the normal pull or autocomplete also finds is one target (same intent key).
- The pull failing writes `comparison_pull: not read: comparison pull: couldn't read Search Console (...)`, which the run prints as a FIND note; every other pick is unchanged. With the screen not read (or answering without its `comparison` list) there is no comparison priority that run, and a row only the comparison pull found is not built unread.
- A comparison page names other companies, so the draft lists them in `rivals` and the gate checks the structure (`rivalProblems`, fails closed): a comparison draft with no `rivals` list is refused, each rival must be named in a verified fact, and any sentence in a paragraph, list or answer that names a rival must repeat one of those facts word for word (headings may name it). Unsourced, it is not published. A fact naming a rival counts only when its source page names that rival too (`verifyFacts`; a draft for "second nature alternatives" pinned a fact to a page about a different product). The page lays the choice out in a table (`sections[].table`, 2-4 columns, 2-8 rows, rendered in an `overflow-x:auto` wrapper so a phone never scrolls the page sideways); a table cell is a claim about a rival when the cell, its row label or its column header names the rival, so rival-by-rival feature grids need sources and the table says how to choose instead; no table is a `d2` note, never a block. The model is asked never to call a rival bad and never to imply affiliation.
- Week report `comparison`: `{pulled, candidates, confirmed (a number or "not read: ..."), queued: [up to 20 queries]}`.

## Hand-given searches (`seeds`) and the product's own facts (v1.17.0)

Her yes, 27 Nov 2026: "yes turn those searches into pages". A site can list, in `seeds`, up to 25 searches handed to it: the searches ChatGPT runs before it recommends an app in the site's category (captured from real ChatGPT answers). Each is a string or `{ "query": "...", "wants": ["no account", "offline"] }` (the feature words the searcher used). Code: `src/seeds.mjs`, `src/product.mjs`.

- **Same checks as a found search.** FIND adds each seed as a candidate, so it meets the page-size and `find.exclude_words` checks, the site-coverage and sibling checks and the free-model relevance screen; BUILD gives it the distinct-intent gate, the page gate and the product-claim check. A seed refused anywhere is recorded with the reason.
- **Order:** AI answer misses, comparison searches, **seeds**, priority topics, the rest (FIND's list and BUILD alike). Seeds still respect the per-site cap: on a full site they wait, queued, until the cap has room (raising the cap is her call).
- **A seed page is a person choosing an app**: it gets the comparison rules (a rival is named only in a sourced fact, a "how to choose" table) and is told what the searcher asked for, so it says plainly which of those the product has.
- **No second page.** A seed with the intent of a live engine page strengthens that page once (CHECK: same gate, product check, snapshot and undo; Search Console can undo it); a seed a hand-built page already answers is recorded as `answered_by` that page (the engine never edits hand-built pages).
- **`product`**: `{ "facts": ["..."], "lacks": ["..."] }`, plain sentences true of the product today (what it is, does, costs, where it runs, whether it is out yet) and what it does NOT do. Required when `seeds` is set. The writer is told these are the only things a page may say about the product, and every new page and every strengthen is read by a free model against them: a sentence giving the product a feature, platform, price or availability the facts do not state stops the page (`product claim: "..." is not in the site's product facts`), and the fix pass is told which. A check that cannot be read (no free model, an answer that is not the JSON asked for, or no claim listed on a page that names the product) writes nothing that run: nothing is dropped and the search stays queued. It is never a pass.
- **Outage:** the relevance screen down = no seed page that run (queued, with the reason).
- **Where it shows:** `data/search-loop/seeds.json` (one row per seed: `built`, `strengthen` (pending), `strengthened`, `answered_by`, `refused` or `queued`, with its URL or reason), the week report's `seeds` block (each configured seed in exactly one list) and the run line `seeds=<n>/built:../strengthened:../answered:../refused:../queued:..`. A built, strengthened or answered seed is never acted on again.

## Which searches FIND asks about, and priority topics (v1.11.0)

The weekly autocomplete budget (`find.max_autocomplete_calls`, 80 = 40 questions to Google and Bing each) is spent in this order: the site's priority topics, easy wins, the other `topics`, winners, the top Search Console queries; every seed is asked bare before any seed gets a question prefix ("how to …"). Before v1.11.0 the Search Console queries went first with all six prefixes, so six of them used the whole budget and a site's `topics` were never asked. `discovery-receipt.json` `seeds` says how many topics were asked; a topic the budget never reached is `NAMED NOTE [FIND_TOPICS_UNASKED]`.

`find.priority_topics: N` makes the first N `topics` the site's priority searches (its buyers' searches). A search carrying more than half of one's words (both words of a two-word topic) is marked `priority` in `targets.json`, goes to the relevance screen first (the best 75) and is built before any other search in either lane, still under the cap, the distinct gate and the page gate. No priority search found in a week is `NAMED NOTE [FIND_PRIORITY_EMPTY]`.

A draft with fewer than two working sources is told which URL failed and how (`HTTP 403: this site refuses automated checks, so cite a different publisher`), so the fix pass replaces it instead of citing it again (v1.11.0; ftc.gov and annualcreditreport.com refuse every automated check).

## Refresh: real freshness, never a fake date (v1.10.0)

Owner goal, 10 Nov 2026, and risk rule R-ADV-12 (FTC Act s5, no fake freshness): every live question page is re-checked every 30-90 days at $0, and its "Updated" date and lastmod move **only** when what the page says changed. Code: `src/refresh.mjs`, run inside CHECK (never on a frozen site, never on a page mid-strengthen).

- **Pace**: `ceil(live / 45)` pages a run, at most 3, oldest first; a page checked or changed in the last 30 days is not due.
- **Sources re-checked and fixed**: every fact's source is fetched again (two tries); a source that is gone (404, 410, unreachable) takes its fact off the page. A 403 or 5xx is "could not tell" and stays. If the fix would leave the page short of the gate's sources, the page is left as it was and `refreshed.left` says why.
- **One real-search question** (normal mode only; slow and off still repair sources): a Search Console query for that page (28 days) that no heading or FAQ on it answers becomes one FAQ entry, written by a free model from the page's own words; a new number, name or link refuses it. The page must pass the gate with no new problem.
- **Dates**: a changed page is re-rendered with `modified: today`, snapshotted, and its `pages.json` entry gets `modified_at` (also set now by strengthen, undo and reshape). A page with nothing to fix gets `refreshed: { at, changes: [] }` and keeps its file, hash and dates. **Sites date engine pages from `modified_at || published_at`**, never from a check or verdict date.
- **Census**: `refreshed=<changed>/<due>` on the run line; due pages and nothing changed is `NAMED NOTE [REFRESH_NOTHING_CHANGED]`.

## Old pages reshaped, the voice line never copied, releases tag themselves (v1.9.0)

Search Readiness q1 (7 Nov 2026) sampled porchandparty901.com question pages with the site's `voice` sentence repeated 5-11 times and a how-to with no numbered steps. v1.7.1 fixed new pages at write time (`capRepeats`, how-to bullets as `<ol>`); v1.9.0 finishes the job:

- **Pages already live are re-rendered once.** CHECK (`reshape`, only where `rules.strengthen` is on, so never on a frozen site) reads each live page for the two gaps (`shapeGaps`: a how-to with no `<ol>`; an 8-word phrase more than 3 times in `<main>`) and re-renders it from its saved draft through today's write path. No model call. Kept only if the gate passes with no gap left; the old page is snapshotted and `reshaped` recorded on the page. A page that cannot be cleared (no saved draft, or the re-render still fails) is left byte-identical, its `reshaped.left` says why, and it is not tried again until `RESHAPE_VERSION` moves.
- **The voice line is a style guide, never copy.** The draft prompt labels it so and asks for no repeated sentence or phrase.
- **Releases tag themselves**: a merge titled `vX.Y.Z: …` is tagged and `v1` moved by the `release` job in `ci.yml`, after the check passes (`NAMED STOP [VERSION_MISMATCH]` if `package.json` disagrees).

## Calendar slots, bylines and local pages (v1.5.0)

For a site that already has an approved editorial calendar (Hicks, 3 Nov 2026), the engine's writer drafts the material for one slot and hands it back; it never publishes and never touches the ledger:

- `search-loop draft-slot --slot slot.json --out draft.json`, or `draftSlot(cfg, slot, { check })` from `src/slot.mjs`. `slot` = `{ title, question?, kind, words: [min, max], avoid: { headings, phrases, sources }, related }`. The approved title is kept; the draft is answer-first, question headings, a 4-question FAQ, 3-4 fetched-and-verified sources, never first person. `check(draft)` adds the site's own blocking checks (e.g. text shared with live pages); its problems go back to the model on the next pass. Stops: `SLOT_DRAFT_REJECTED`, `NO_FREE_MODEL`, `FREE_MODEL_KEY_MISSING`.
- `reserved_titles` (config): a JSON list of `[{ route, title }]` the site has scheduled. They count as existing pages in the distinct-intent gate, so the loop never writes a question page on a search a calendar post will answer.
- `author: { name, url }` (config): question pages show the person as the visible byline, with Person schema.
- `local.substance` (config): what every page naming one of `local.city` / `local.neighbourhoods` must carry (communities served, landmarks, local resources with sources), so a local page is never a city-name swap.
- `distinct.near_dup` (config, at most 0.35): a stricter near-duplicate threshold between pages.

## Two lanes: can be #1 now, and striking distance (v1.6.0)

Her ruling, 3 Nov 2026: "we shouldnt be working hard to get from 10 to 1 and sometime we do that but sometimes we find where we can just be 1 or closer to 1 and move forward". Code: `src/compete.mjs`.

- **Lanes** (config `competition.lanes`, default `{ can_be_one: 2, striking: 1 }`). FIND ranks every search twice: a can-be-#1 score and the striking score (`scoreCandidate`: Search Console position 8–30, autocomplete, Bing). Each lane takes its best search in turn; BUILD picks the next search from the lane behind its share of the pages made, so skips never skew the split. Every target and every `pages.json` entry carries `lane`, `score`, `scores` and `reasons`.
- **Can-be-#1 signals, free, from Search Console** (always on):
  - *Easy-win neighbours*: searches where the site reached the top 3 with ≤50 impressions, or an engine page in the top 3 at its 2-week check. Their close variants are seeded into autocomplete first, local variants are made for each of the site's other places, and a candidate sharing ≥50% of an easy win's words scores up.
  - *Nobody answers this exact question*: a 4+ word search no site page covers, whose parts the site already holds at position ≤10.
- **Top-10 read** (optional, provider interface; first provider Brave Search API). Off unless `BRAVE_SEARCH_API_KEY` is passed; without it FIND writes `not read: no BRAVE_SEARCH_API_KEY` and uses the Search Console signals only. Plain rules over the top 10: directories (Psychology Today, Zocdoc, Yelp, Thumbtack, Angi …), forums (Reddit, Quora …), off-target national pages for a local search, thin or old pages (count as weak), pages that answer the exact question (count as strong); the top 3 count double. A weak top 10 = a high can-be-#1 score. Only counts and reasons are stored, never the results. Google is never scraped.
- **$0 only** (her rule: "starting with free credits and not going above $0"). Brave's free credit is $5/month = 1,000 searches. The fleet uses at most 70%: each site gets `floor(1000 × 0.7 / 14)` = 50 reads a month and 15 a day (`competition.top10.monthly_budget` / `daily_budget` can lower it, never raise it). Usage and Brave's `x-ratelimit-*` headers are kept in `serp-budget.json`; a 402/429, or a monthly quota header with 30% or less left, ends reads for the month with `not read: Brave free budget used`.
- **Learning**: every 2/4/8-week checkpoint records `lane` and `top3`. The week report's `lanes` block shows, per lane, pages, measured, top3 and `hit_rate`. Weekly, each can-be-#1 weight (`neighbour`, `unanswered`, `weak_top10`) moves 10% up (≥50% of ≥5 pages picked on it reached the top 3) or down (<20%), within 0.5×–2× its default; each change is logged in `lane-weights.json` and in the report.

## Distinct pages and the per-site cap (v1.3.0)

Her ruling, 3 Nov 2026: the search loop publishes only distinct pages, under a per-site cap that grows with results. Five sites lost most of their Google exposure under thousands of near-identical template pages and recovered only after cutting to a few dozen to a few hundred distinct pages. This replaces the old fixed pace (10/day, +5/week, cap 30).

**Distinct intent gate** (`src/distinct.mjs`). Before a search is drafted, and again on the draft's H1 and answer, it is compared with every page the site already has: page titles and H1s, the engine's own live question pages, and every URL in the site's `sitemap*.xml` files at the repo root (`distinct.sitemap_files` to name others). Same intent means: the same intent words after normalising (stop words, intent verbs like "how to / avoid / tips", plurals removed); a Jaccard overlap of those words of at least `distinct.jaccard` (0.6); every intent word of the shorter one (3+ words, `distinct.containment_min_words`) inside the longer (the template shape: "wedding budget spreadsheet" + "for a small wedding"); or, after drafting, a direct answer sharing at least `distinct.same_answer` (0.5) of its 3-word shingles with an engine page's. A match publishes nothing: the search becomes a **strengthen brief** for the existing URL (added to `targets.json` `strengthen`, and to an engine page's own strengthen queries) and is logged in `pages.json` `redirected` and the week report's `redirected` (query + URL + why).

**Outcome-gated cap** (`src/cap.mjs`, ledger `cap.json`). New pages publish only while the site's live engine pages are under `cap.max_live_pages`. Starting value: the site's setting, or by default the site's distinct live engine pages (near-twins count once), at least `cap.start_pages` (20). Once a week, before BUILD, the engine reads Google impressions from Search Console by date: the last 28 days (ending 3 days ago) against the 28 before. Beat them → the cap rises by `cap.grow_share` (10%); fell → it drops back by the same share (never under `cap.min_pages`, 10); flat → held. Impressions in the last 28 days with no rows before them (a site new to Google; Search Console omits days with no impressions) → the 28 before count as 0 and the cap rises. **No Search Console numbers → the cap holds** (no growth), with `NAMED NOTE [CAP_HELD_NO_DATA]` naming why. Every change is logged with its reason in `cap.json`. `cap.max_per_day` (10; 3 in `slow`) is a run guard for the shared free lanes, not a pace: it never grows. Searches the cap holds back stay queued and are counted in the report's `held_by_cap`.

**Frozen published pages** (her ruling, 3 Nov 2026: Horse and Hicks). On `horselegalguide.com` and `hicksconsulting.org` (the `FROZEN_SITES` list in `src/config.mjs`, keyed by host so no caller changes), or any site with `published_pages_frozen: true`, the engine never modifies, redirects, merges, unpublishes or undoes an already-published page: no related links are inserted into existing pages, the 2/4/8-week checks record numbers but never strengthen, undo or merge, and a same-intent search is skipped (logged in `pages.json` `dropped`), never turned into a strengthen brief. New pages still publish under the site's approval rules.

The week report says: `published`, `held_by_cap`, `redirected` (with the existing URLs), and `cap` (`max_live_pages`, `live`, `room`, `why`).

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
| `author` | no | `{ name, url }`: the visible byline and Person schema on question pages (v1.5.0) |
| `reserved_titles` | no | path to `[{ route, title }]` the site has scheduled; same-intent searches are skipped (v1.5.0) |
| `cap` | no | `max_live_pages` (null = start from the site's distinct live engine pages, at least `start_pages` 20), `grow_share` 0.1, `min_pages` 10, `max_per_day` 10 (≤ 30). The old `pace` key is retired and ignored |
| `distinct` | no | same-intent thresholds: `jaccard` 0.6, `containment_min_words` 3, `same_answer` 0.5; `sitemap_files` (default every `sitemap*.xml` at the root) |
| `published_pages_frozen` | no | `true` = never modify, redirect, merge, unpublish or undo a published page (always on for Horse and Hicks) |
| `approval` | no | `{ "new_pages": true }` = approval mode: BUILD writes each new page to `approval.pending_dir` (default `<ledger_dir>/pending`, the owners' queue) with `pages.json` status `pending_approval`, never into the site and never linked from it; a page goes live only when its slug is under `approved` in `approval.approvals_file` (default `<ledger_dir>/approvals.json`, `{ "approved": [slug], "declined": [slug] }`), and a declined page leaves the queue. The day's limit counts queued pages. |
| `menu_pages_need_approval` | no | `true` = never edit menu pages (`menu_pages[]` or the homepage `<nav>` links) |
| `menu_pages` | no | explicit list of menu routes |
| `health_gate` | no | `none` (default), `health`, `dental`; with `health.real_facts` `{services[], hours}` |
| `gate.banned_patterns` | no | regular-expression strings (case-insensitive) a page must never contain in its title, meta or body: the site's claim guard, claims it may never make (legal, defamation, health), so a page its build would refuse is never committed (v1.9.1); applied in the calendar lane too (v1.12.2). Not for style: a word list never judges whether copy reads as machine-written (v1.15.0) |
| `gate.own_prices` | no | the site's own offer text, written exactly as on the page (e.g. `DIY Credit Letter Kit ($19 once)`): taken out before the unsourced-price check, like the action label always is (v1.12.1) |
| `protected_paths[]` | no | files/dirs the engine never edits (e.g. a protected sales page) |
| `shares_audience_with[]` | no | `{site, ledger_url \| ledger_path}` of sibling sites; two sites never target the same search |
| `local` | no | `{city, neighbourhoods[]}` adds local question sets |
| `site_words` | no | the brand part of a long `site_name` (e.g. `"Dianne's Place"`), left out of intent comparisons instead of every word of the full name |
| `publisher` | no | `{name, url, logo?, sameAs?[]}` for Article author/publisher (an organization; never an invented person); `logo` and `sameAs` are copied only when given |
| `template` | no | `stylesheets[]`, `og_image{url,width,height}`, `header_html`, `footer_html`, `section_name` |
| `related` | no | `max_pages_per_new_page` (2), `scan_dirs[]`, `skip_dirs[]` |
| `competition` | no | `lanes` `{can_be_one: 2, striking: 1}`, `top10` `{provider: brave\|none, daily_budget: 15, monthly_budget: 50}` (can lower, never raise past the fleet ceiling), `min_can_be_one` 15 |
| `find` | no | `gsc_position_min` 8, `gsc_position_max` 30, `max_autocomplete_calls` 80, `max_targets` 200, `exclude_words[]`, `priority_topics` 0 (how many of the first `topics` are the site's priority searches: asked, screened and built before any other, v1.11.0) |
| `gsc` | no | `site_url` or `site_url_env` (default env `GSC_SITE_URL`) |
| `llm.routing_file` | no | the site's own $0 routing file (OpenRouter `:free` models); default [`config/free-models.json`](config/free-models.json) |
| `indexnow` | no | `{key, key_location}` — the key the site already serves |
| `analytics` | no | `ai_referrals` / `ai_bot_hits`: `cloudflare` (+ `zone`) or `none`. v1.5.1: bot reads by user agent work on every plan; on a free zone (no referrer field) visits come from Cloudflare Web Analytics when its beacon is on the site, else "not read" with the reason. The token needs Account + Zone Analytics:Read |
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
      BRAVE_SEARCH_API_KEY: ${{ secrets.BRAVE_SEARCH_API_KEY }}   # optional top-10 read, free credit only
```

Optional inputs: `setup_command` (e.g. `npm ci --ignore-scripts`), `post_build_command` (the site's own finishing step: header, styles, sitemaps — runs after any run that wrote, rewrote or removed a site file, new page or not: the engine's `pages_written` output counts the files outside its ledger that changed, read from git, and `unknown` (with `NAMED NOTE [PAGES_WRITTEN_UNREAD]`) also runs it; if it fails, the run is red with `NAMED STOP [POST_BUILD_FAILED]` and nothing is committed. Since v1.17.2; before, it ran only when a new page was published, and porchandparty901.com shipped three strengthened pages with no header or styles. A caller that pins the workflow to a commit needs that pin moved to get it), `commit_command` (the site's own commit helper), `node_options`, `stage`, `config`. Only the default branch publishes; a run on any other branch is a **proof run** (builds, gates, reports, uploads the pages as `search-loop-pages`, commits nothing). Add `.search-loop-engine/` and `.search-loop-run.log` to the site's `.gitignore`.

**Check the config on every pull request** (v1.12.0). `stage: validate` runs only `validate-config`: the config checks and the model-routing checks the run itself makes (`llm.routing_file` or the engine's, `FAIL_LOUD` on a policy or pricing break), no network, no model call. Add to the caller:

```yaml
on:
  pull_request:
    paths: [search-loop.config.json, config/llm_routing.json, .github/workflows/search-loop.yml]
concurrency:
  group: ${{ github.event_name == 'pull_request' && format('search-loop-pr-{0}', github.ref) || 'search-loop' }}
jobs:
  search-loop:
    with:
      stage: ${{ github.event_name == 'pull_request' && 'validate' || inputs.stage || 'auto' }}
```

(peace-be-still, 18 Nov 2026: a routing file with `paid_fallback` and unpriced `models` failed every scheduled run since adoption and nothing ran it before merge.)

3. **Secrets** — all optional; a missing one is a `NAMED NOTE [SECRET_MISSING_…]` line (job summary; the run stays green) and the stages that need it write `not read`. No paid key is ever used: the model route is $0-only (`max_cost_usd: 0`, `fallback_to_paid: false`, a non-zero `usage.cost` fails loud).

4. **Ledger** (committed to the site under `ledger_dir`): `targets.json`, `discovery-receipt.json` (every host called, cost 0), `pages.json` (every page, checks, strengthen hashes), `drafts/`, `snapshots/` (pre-strengthen bytes for undo), `cap.json` (the per-site cap, its history and held counts), `consolidation-ledger.json`, `winners.json`, `ai-daily.json`, `runs.json`, `serp-budget.json` (top-10 reads used and Brave quota headers), `lane-weights.json` (can-be-#1 weights and their change log), `ai-misses.json` (one action per AI answer miss per Boss OS week, and the last reads; v1.14.0), `search-loop-week.json`.

## Exit codes and Rule 0

`0` work done and visible · `1` problems (bad config, bad report) · `2` `NAMED STOP [NOTHING_DONE]` — nothing found, built, checked or measured (a CHECK that read Search Console for its live pages, none due, is work: census `measured=N`) · `3` model key missing/refused with nothing else done · `9` push failed: `NAMED STOP [PUSH_CONFLICT]` (a real conflict outside the ledger) or `NAMED STOP [PUSH_FAILED]` (five refused pushes). The default commit step (`bin/commit-push.mjs`) fetches and rebases onto the moved default branch and retries with jitter, merging the engine's own ledger JSON by record key, so another job pushing to main meanwhile is never a failure. Every run ends with a census line.

## Develop

```sh
npm run check        # validator + its self-test, unit tests, engine --self-test
node bin/search-loop.mjs run --config search-loop.config.json --stage find   # in a site checkout
```

Releases: semver tags `v1.x.y` plus the moving `v1` tag that callers pin. v1.17.2: the site's finishing step (`post_build_command`) runs after any run that wrote, rewrote or removed a site file (`pages_written`, read from git; `unknown` runs it too), not only after a new page; a failed finishing step is `NAMED STOP [POST_BUILD_FAILED]` and nothing from that run is committed. v1.17.0: hand-given searches (`seeds`, built after comparison searches and before priority topics, through every check a found search meets; a seed with a live engine page's intent strengthens it) and the product's own facts (`product`: every new page and strengthen is read by a free model against them; a claim they do not support stops the page; a check not read writes nothing). v1.16.0: comparison searches first: one extra Search Console pull filtered to people's comparison searches, confirmed by the free-model screen, built after AI answer misses and before priority topics; a comparison page's claims about another company must be sourced facts (`rivals`); week report `comparison` block. v1.15.3: a site new to Google (impressions in the last 28 days, no Search Console rows in the 28 before, which Search Console leaves out when a day had no impressions) counts the 28 before as 0, so its cap grows with its first results instead of holding forever (keepmyproof.com launched 1 Nov 2026 and held at 20 for four weeks with 4,119 impressions). With no impressions in either window it still holds with `CAP_HELD_NO_DATA`. v1.15.2: a live page ends in the site's current one action after CHECK (when the config's action changes, CHECK swaps it into live pages). v1.15.1: a web address on the site's own host written in a page's prose is now a link (other hosts stay text), and the week report's `ai_misses.could_not_tell` counts a failed read on its Central date. v1.15.0: the engine-wide machine-writing word list and the filler-phrase note are gone (her ruling 23 Nov 2026, "Drop the list"); whether copy reads as machine-written is judged by the model reviewer in context. A site's `gate.banned_patterns` claim guard stays. v1.14.0: AI answer misses from Boss OS strengthen the engine page that fits first (no Search Console gate, same gate, snapshot and undo, one action per miss per week), a miss with no page becomes a FIND search built first, and the week report gains an optional `ai_misses` block; a strengthen that adds nothing no longer re-dates a page, and no re-render (strengthen, refresh, reshape) touches a page edited by hand since its draft was saved. v1.12.2: a page's "Related questions" link and ledger route use its canonical address on `base_url` when it has one, not its repo path (detoxdenver.org serves `public/`, so every related link pointed at /public/questions/…, a 404). The model is given related pages by their H1, never the "Title | Site" tab text (BUILD and the calendar lane). The shared banned words (unlock, elevate, dive in, delve, seamless, empower, tailored, embark, AI-powered, sparkle(s); the ship-ready-baseline list) block a page in BUILD, CHECK and the calendar lane, and the calendar lane now also applies `gate.banned_patterns`. v1.12.1: the gate blocks an unsourced price (`invented: unsourced price`: "$79", "USD 60", "ninety-nine dollars" in a sentence with no verified fact), since every price claim about another company needs a source (risk R-ADV-13; approvalprep.com /questions/how-much-does-credit-repair-cost/ shipped spelled-out competitor fees on 16 Nov 2026); the site's own action label and optional `gate.own_prices` are exempt, and the draft prompt says so. v1.12.0: `validate-config` also checks the model routing file (the run's own FAIL_LOUD checks) and `stage: validate` runs only that, for a caller's `pull_request` trigger; mode-sync pushes through `bin/commit-push.mjs` (rebase and retry). v1.9.2: the answer under the H1 defines its subject (b4, "X is ..."): the writer rewrites a "To X, do Y" or "X include Y" lead, any other lead goes back to the model once more (the passing draft is kept if that try is no better), and CHECK `reshape` (`RESHAPE_VERSION` 2) re-renders live pages whose answer defines nothing (porchandparty901.com /questions/party-rentals-memphis failed the Monday sample's b4). v1.9.0: live pages built before v1.7.1 are re-rendered once to drop template filler and give how-to steps (CHECK `reshape`), the voice line is labelled never-copy in the prompt, and a `vX.Y.Z:` merge tags itself and moves `v1` (the `release` CI job). v1.8.0: fixable drops retry after 3 days with their last problems, and searches in another language are skipped (BHPC's first blitz run dropped "ai leadership coach" for a short FAQ answer, and queued German and Dutch searches). v1.7.4: a slip in the leading question word ("hot to", "waht") is corrected before it becomes the page address (virtualagency-os.com shipped /questions/hot-to-set-up-a-virtual-event). v1.7.3: the repeat cap reads "Mt. Moriah" as one sentence (an abbreviation's full stop hid a fourth use). v1.7.2: `publisher.logo` and `publisher.sameAs` reach the Article author/publisher Organization; optional `site_words`. v1.7.1: a sentence that would use an 8-word phrase a fourth time is dropped from the draft (template filler, the Monday page-quality sample), and a how-to page gives its bullets as numbered steps (`<ol>`). v1.7.0: every run's `NAMED STOP [CODE]` becomes a Boss OS Open Loops row (bin/report-stops.mjs, one per repo#CODE; a cleared code closes its row); pass `BOSS_OPEN_LOOPS_TOKEN` in the caller's `secrets:` block, optional `open_loops_business` (default `spry`). v1.3.0: distinct intent gate, outcome-gated per-site cap (replaces the fixed pace), frozen published pages for Horse and Hicks.
