# RopeDrop Bot (`ropedropplannerbot`)

## Overview

RopeDrop Bot is a Reddit app for **r/ropedropplanner**, a community about
planning Disney theme-park days. It helps people with the questions that come
up again and again ("When is Slinky Dog shortest?", "Is EPCOT busy on
Friday?", "How much is a Dole Whip?", "What can a 40-inch kid ride?") by
answering from RopeDrop Planner's historical wait-time data and published
park information.

**Everything is computed inside Reddit, and it works out of the box.** Each
build of the app embeds a snapshot of RopeDrop Planner's public, precomputed
data bundle, so it answers right after install with **no external request at
all**. Once a day the app GETs the newest bundle (see
[Fetch Domains](#fetch-domains)) and stores it in the app's Redis, which only
keeps the data fresh. Questions are parsed and answered by code in this repo;
post and comment text is never sent anywhere.

What it does:

1. **Answers new posts.** When someone creates a post, the bot parses the
   title and body. If it's confident in its answer (70% by default), it
   replies with the answer, up to three links to ropedropplanner.com pages,
   and a short footer with a feedback link. If it isn't confident, it stays
   silent.
2. **Answers when summoned.** A comment that mentions `u/ropedropplannerbot`
   is treated as a question (the mention is removed first). Other comments
   are ignored.
3. **Posts a daily "Today's Crowd Outlook"** each morning (7:00 AM US Eastern
   by default) with the expected crowd level, park hours and a rope-drop
   pick for each park.
4. **Gives moderators an "Ask RopeDrop bot" menu item** on posts and comments
   to request an answer on demand.

What it can answer (all 12 parks at Walt Disney World, Disneyland Resort,
Disneyland Paris, Tokyo, Hong Kong and Shanghai unless noted):

| Topic                         | Examples                                                                                                        | Data window                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ride timing                   | "best time to ride Slinky", "Flight of Passage wait in the afternoon"                                           | posted-wait averages, last ~90 days                                                    |
| Ride order at open            | "Rise or Indy first?"                                                                                           | opening-rush profile (first 15 min after the official open vs 2 h later), last 60 days |
| Rope drop, busy/quiet windows | "what should we rope drop at HS on Saturday?"                                                                   | last 90 days                                                                           |
| Crowds on a date or period    | "Is MK busy tomorrow?", "Mondays in mid-October", "least busy weeks this winter"                               | the site's crowd calendar forecast, next ~6 months; months/seasons ranked by week     |
| Crowd patterns                | "quietest day of the week at Epcot", "weekends vs weekdays at Disneyland", "Tokyo DisneySea during Golden Week" | last 90 days; holidays for DLR/TDR/HKDL                                                |
| Park hours                    | "MK hours tomorrow"                                                                                             | Disney's published hours, next 30 days                                                 |
| Lightning Lane (WDW)          | "Multi Pass price at MK on Oct 3", "when does 7DMT Single Pass sell out?"                                       | captured prices; sell-out times in ET since Apr 2026                                   |
| Menus and prices              | "how much is a Dole Whip", "breakfast menu at Be Our Guest", Drinking Around the World                          | Disney menus seen in the last 30 days                                                  |
| Ride facts                    | height ("what can a 40-inch kid ride"), indoor rides, rides with no minimum height, rain-sensitive rides        | ride data / rain analysis window                                                       |
| Events and closures           | "Halloween party on Oct 9?", "what's closed for refurb at MK?"                                                  | Disney's schedule (14 days), closures as of the nightly snapshot                       |

Opinion questions ("is Lightning Lane worth it?", "which hotel is better?",
restaurant recommendations) are left to humans: the bot stays silent. Every
answer states its window or an "as of" time and never adds numbers the data
doesn't contain (a number guard caps confidence if one slips in).

Who it's for: members of r/ropedropplanner who want a quick, data-based answer,
and moderators who want the repetitive questions answered consistently.

Safety and operational notes:

- **Dry run is ON after install.** Until a moderator turns off _Dry run_, the
  bot only writes to the app logs what it _would_ post. Nothing appears on Reddit.
- It never replies twice to the same post or comment, and it sends at most
  **5 automatic replies per rolling hour** (configurable).
- It skips posts by moderators (e.g. announcements), its own posts,
  removed/deleted content, and posts flaired _Trip Report_, _Photo_, _Photos_
  or _Meta_ (configurable). A comment that mentions the bot is answered even
  when a moderator wrote it (a mention is an explicit request).
- It answers from the newest data it has: the daily-refreshed copy in Redis
  or the snapshot built into the app, whichever was generated later. If
  neither is usable or the newest is more than 30 days old, the bot logs it
  and does nothing. It never posts an error message.
- Date-bound answers only cover the dates the data covers (hours 30 days,
  crowd forecasts ~6 months (183 days), events 14 days, from the data's own date; LL prices
  for the dates captured) and stay silent beyond them. When the data is from
  an earlier day, hours and crowd answers say "as of <date>" instead of
  presenting it as current, closures need data from the last 2 days, and the
  daily "Today's Crowd Outlook" is only posted from data built that day.

## For Reddit reviewers: how to test

1. Install the app on a test subreddit. It answers immediately from the data
   built into the app; the `ropedrop-bot-data.storage.googleapis.com` fetch
   only refreshes that data daily (GET-only, public files, no user data sent).
   The install log shows which data it uses, e.g.
   `[bundle] embedded snapshot 20260928T1750Z loaded (...)` and
   `[bundle] answering from embedded:20260928T1750Z (generated 2026-09-28T17:50:11Z)`.
2. **Dry run is ON by default**: the bot then only writes what it _would_
   reply to the app logs (`devvit logs <subreddit>`), and nothing appears on
   Reddit. To see real replies, turn off _Dry run_ in the app's settings for
   the test subreddit.
3. Ask a question in one of these ways (the bot skips **posts** by the
   subreddit's moderators on purpose, so a moderator should use b or c):
   - a. a new post from a non-moderator account, e.g. title
     _"What time does Magic Kingdom open tomorrow?"_;
   - b. a comment that mentions the bot, e.g.
     `u/ropedropplannerbot when is the best time to ride Slinky Dog Dash?`;
   - c. the moderator menu item **Ask RopeDrop bot** on any post or comment.
4. Example questions that it answers:
   - "When is the best time to ride Slinky Dog Dash?"
   - "Is EPCOT busy on Friday?"
   - "What time does Magic Kingdom open tomorrow?"
   - "How tall do you have to be for TRON?"
   - "How much is a Dole Whip?"
   - "What should we rope drop at Hollywood Studios on Saturday?"

   Opinion questions ("Is Lightning Lane worth it?") and statements get no
   reply, by design.

5. Every post, comment and mention the bot handles writes exactly one log
   line (no post text, no usernames), e.g.
   `[bot] post t3_abc mode=auto outcome=dry_run intent=best_time confidence=0.95 dest=wdw data=embedded:20260928T1750Z`.
   `outcome` is `replied`, `dry_run`, `silent` or `skipped`, with a `reason`
   when it didn't answer (`low_confidence(...)`, `author_is_mod`,
   `no_mention`, `flair_skipped`, ...).

## Privacy

- **Post and comment text never leaves Reddit.** It is parsed in the app and
  is not stored, logged or sent to any server or AI model. Logs contain only
  post/comment IDs, the decision, the detected intent/destination, the
  confidence and which data answered (see the log line above); in dry run,
  also the reply the bot would have posted.
- The only outgoing requests are `GET`s of public data files from
  `ropedrop-bot-data.storage.googleapis.com`. No usernames, IDs, post text or
  other user data is included in them.
- Redis holds: the public data bundle (the same files anyone can download),
  post/comment IDs for duplicate protection (expire after 30 days), a rolling
  list of reply IDs for the hourly cap (expires after 2 hours), and a
  "posted today" marker for the daily post (expires after 3 days). No
  Reddit content.
- No LLM is used. Reddit data is never used to train models.

## How it works

```
                          r/ropedropplanner
 new post ─────────────┐        │        ┌──────── mod clicks "Ask RopeDrop bot"
 new comment ──────────┤        │        │              (post or comment menu)
  (only if u/bot       ▼        ▼        ▼
   is mentioned) ┌──────────────────────────────────────────────┐
                 │ Devvit app (Devvit Web, server-only)          │
                 │  src/index.ts        Hono routes              │
                 │  src/core/engine.ts  decide + reply           │
                 │  src/core/logic.ts   filters, reply format    │
                 │  src/bot/*           parser + answers (pure)  │
                 │  src/bundle/*        bundle sync + reader     │
                 │  src/server/deps.ts  Reddit / Redis wiring    │
                 └───┬───────────────────────┬──────────────────┘
     Redis           │                       │ Reddit API (as the app account)
  bundle:v1:current ─┤ one pointer, flipped  │  submitComment / submitPost
  bundle:v1:gen:<g>  │ after a generation    │
  bundle:v1:blob:... │ is fully stored       │
  replied:/lock:/... │                       │
                     ▲
   GET only (cron 09:10-12:10 UTC, install, upgrade)
   https://ropedrop-bot-data.storage.googleapis.com/bundle/v1/manifest.json
   + the files it lists (public, precomputed nightly at 04:15 ET)
```

**Data layer** (`src/bundle/sync.ts`, `src/bundle/source.ts`,
`src/bundle/embedded.ts`):

0. **Embedded snapshot.** `npm run snapshot` (`scripts/snapshot-bundle.mjs`,
   plain Node on the developer machine) GETs the current manifest and every
   file it lists, verifies each file's byte count and SHA-256 against the
   manifest, drops fields no answer reads (show lists, showtimes, per-drink
   DAW lists) and writes one gzipped JSON container to
   `snapshot/bundle.json.gz` (git-ignored). `vite.config.ts` inlines it into
   `dist/server/index.cjs` as base64 (`virtual:rdb-snapshot`). The server
   decodes it once per instance with `node:zlib` (a Node built-in that the
   Devvit server bundle already loads) and reads it from memory; it is never
   written to Redis. Size for generation `20260928T1750Z`: 3.58 MB of JSON
   downloaded → 3.38 MB trimmed → **624 KB gzipped** (832 KB as base64 in the
   bundle). `npm run build` and `devvit upload`/`publish` (via `scripts.build`
   in `devvit.json`) always take a fresh snapshot, so every upload ships
   current data; `npm test` and `devvit playtest` reuse an existing one
   (`--if-missing`) so they work offline.

1. A scheduler task (`bundle-refresh`, cron `10 9-12 * * *` UTC, i.e. about
   05:10 ET with three hourly retries) and the `onAppInstall` / `onAppUpgrade`
   triggers GET `manifest.json` and check `schema`/`schema_version` and that
   `base_url` is on the allow-listed host.
2. If the manifest's `generation` is the one already stored, it stops (one
   small GET per run).
3. Otherwise it downloads each file, checks the byte count and SHA-256 from
   the manifest, decodes it as UTF-8 JSON and stores it under a
   content-addressed key, split into values of at most 1,000,000 characters
   (< 3 MB each; Devvit allows 5 MB per request). A blob's "complete" marker
   is written last.
4. It writes the generation's metadata, then flips `bundle:v1:current` (a
   single `SET`, so readers never see a half-written generation) and keeps the
   previous generation in `bundle:v1:previous`.
5. Older generations and blobs only they used are deleted. A failed run
   leaves `current` untouched; the next run retries and cleans up.
6. Readers (`openRedisBundle`) follow `current`, fall back to `previous` if a
   file can't be read, and parse each file lazily at most once per request.
   A generation is ~3.6 MB (47 Redis keys); with the previous one kept, ~7.2 MB.
7. **Load order** (`dataSources`): the Redis generation and the embedded
   snapshot, ordered by their `generated_at`, newest first (Redis wins a tie).
   Each answer tries them in that order, so an unreadable or missing Redis
   generation falls back to the embedded snapshot. A failed fetch never
   affects answering.

**Answers** (`src/bot/`): `parse.ts` turns each question sentence into a
destination, park, rides, dates, time window and intent; `answer.ts` reads
the facts from the bundle, fills a deterministic template and computes
confidence in code; `extra.ts` holds the intents that are new in this app;
`summary.ts` renders the daily outlook. Long posts are split into sentences;
up to 3 questions are answered, and the bot stays silent if the first (main)
question can't be answered.

Reply decision, in order: already replied? → hourly cap (automatic replies
only) → in-flight lock → still visible on Reddit? → answer from the bundle →
confidence ≥ threshold? → dry run? (log) → post the reply → record the id.

Reply format:

```
<answer>

- [link title](url)        (up to 3)

---
^(I'm the RopeDrop Planner bot, answering from our wait-time data.) [^(Feedback)](<feedback link>)
```

## Parity with the previous (server-side) bot

The parser and answer templates are a line-by-line port of the Python code
that served `/api/bot/ask` (`bot_parse.py`, `bot_answer.py`,
`bot_summary.py`): same intents, confidence formula, 0.7 threshold, number
guard, multi-question handling (max 3 answered parts, silent when the main
question can't be answered), mention stripping and answer text.

`test/fixtures/parity_expected.json` holds the Python output for the 29
evaluation posts, produced by running the Python functions against the same
frozen bundle (`scripts/parity/`; every database read replaced by the same
value from the bundle — its reply/silent decisions match the Python code on
the live database for all 29). `src/bot/parity.test.ts` asserts the
TypeScript answer text, confidence, intent and links are identical, except
for these intentional changes:

| Change                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                 | Posts affected                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Best/worst hours ignore hours with < 10% of the ride's busiest hour's samples  | After-close stragglers (e.g. 17 stale readings at 9 PM for Flight of Passage vs ~920 at midday) were reported as the "shortest wait" and their tiny sample count capped fact quality at 0.6, so "Flight of Passage wait in the afternoon" scored 0.66 and stayed silent. Now 0.95, and the shortest-wait hour is a real one (7 PM). The 0.7 threshold is unchanged. | (none of the 29 change)                                                                                                                                                                                           |
| B. "Which ride first" uses the opening-rush profile                               | The hour-of-day averages blended days with different opening times and flattened the first hour. Now: median posted wait in the first 15 min after the official open vs 2 h later, weekday/weekend from the date, falling back to all days, then to the old method. Same thresholds (climb ≥ 10 min to name rides; "steady" capped at 0.6).                         | live4 (Rise vs Indy: now "similar climb"), title_body_slinky_or_rise (now answered: Rise climbs 10, Slinky 0), bullet_plan_make_sense (now "steady" → the post goes silent, since its main question is the order) |
| C. Closed-rides list only in WDW/DLR                                              | Tokyo's Splash Mountain still runs.                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                 |
| D. All six destinations answered; `intl_ride_aliases` for the international parks | The bundle has the data; Python answered WDW/DLR only.                                                                                                                                                                                                                                                                                                              | tokyo_golden_week (now answered from TDR holiday data)                                                                                                                                                            |
| E. New intents (table above)                                                      | New data in the bundle. Height questions used to be treated as opinion.                                                                                                                                                                                                                                                                                             | height_tron (now "48-inch minimum, a 47-inch child is 1 inch too short")                                                                                                                                          |
| F. No live waits                                                                  | The bundle has no live snapshot, so "current wait" answers fall back to the historical typical wait — what the Python code did whenever its live cache was stale (quality 0.5, silent at 0.7).                                                                                                                                                                      | —                                                                                                                                                                                                                 |

To regenerate the golden file after a backend change, see the header of
`scripts/parity/gen_expected.py` (needs a checkout of the private backend).
The frozen, trimmed bundle is `test/fixtures/bundle` (gzipped; rebuild with
`node scripts/make-fixture-bundle.mjs <downloaded bundle dir>`).

## Settings

Subreddit settings are edited by moderators on the app's install settings
page (`https://developers.reddit.com/r/ropedropplanner/apps/ropedropplannerbot`).
There are **no global settings and no secrets**.

| Setting             | Scope     | Default                                    | What it does                                                                                              |
| ------------------- | --------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `dryRun`            | subreddit | **on**                                     | Log what would be posted instead of posting. Turn off to go live.                                         |
| `minConfidence`     | subreddit | `0.7`                                      | Minimum confidence for an automatic reply (0.5–1).                                                        |
| `maxRepliesPerHour` | subreddit | `5`                                        | Max automatic replies in any rolling 60 minutes (0–60). Only real replies count.                          |
| `skipFlairs`        | subreddit | `Trip Report, Photo, Photos, Meta`         | Comma-separated post flairs to ignore (exact match, case-insensitive). Applies to automatic post replies. |
| `feedbackUrl`       | subreddit | modmail compose link for r/ropedropplanner | Link behind "Feedback" in the footer.                                                                     |
| `dailyPostEnabled`  | subreddit | on                                         | Post "Today's Crowd Outlook" daily.                                                                       |
| `dailyPostHourET`   | subreddit | `7`                                        | Hour (0–23, US Eastern) for the daily post.                                                               |
| `dailyDestination`  | subreddit | `wdw`                                      | `wdw` (Walt Disney World) or `dlr` (Disneyland Resort).                                                   |
| `dailyPostSticky`   | subreddit | off                                        | Distinguish and sticky the daily post (slot 1).                                                           |

Mod menu "Ask RopeDrop bot": ignores the flair skip list, the moderator-author
rule and the hourly cap, but still requires confidence ≥ **0.5** (hard floor)
and still never replies twice. Its toast says _Replied_, _Low confidence_,
_Already replied_, _Dry run_, _Skipped_ or _Error_.

## Fetch Domains

The following domain is requested for this app:

- `ropedrop-bot-data.storage.googleapis.com` — a Google Cloud Storage bucket
  that hosts RopeDrop Planner's public, precomputed data bundle
  (`/bundle/v1/manifest.json` and the JSON files it lists: park hours, crowd
  forecasts, wait-time profiles, ride facts, events, menus and prices). The
  app only makes `GET` requests to download these files, once a day plus on
  install/upgrade, and stores them in Devvit Redis. The answers are computed
  entirely inside the app. We need an external host because the bundle is
  built nightly from our wait-time database (tens of millions of readings)
  and forecasting models, which cannot run inside Devvit; Devvit has no way to
  receive that data otherwise. **No user data is sent**: the requests carry no
  post text, usernames or IDs, and the files are the same public files anyone
  can download.

  Category (per the [HTTP Fetch Policy](https://github.com/reddit/devvit-docs/blob/main/docs/capabilities/server/http-fetch-policy.md)):
  **2 — limited-scope cloud provider**, approved provider
  `storage.googleapis.com`, requested at the most granular hostname (our own
  bucket), use case **asset hosting** (static, read-only files).

Earlier versions requested `ropedropplanner.com` (a personal domain, which
the policy does not allow). This version makes no requests to it; answers
still _link_ to ropedropplanner.com pages, which needs no fetch permission.

**The app works without this domain.** Every build embeds a snapshot of the
same public bundle, so the bot answers out of the box with zero external
requests; the domain only refreshes that data daily. While the domain is not
approved, the refresh logs an error (`HTTP request to domain ... is not
allowed`) and the bot keeps answering from the embedded snapshot.

Domain approval: domains listed in `devvit.json` → `permissions.http.domains`
are submitted for review on `devvit playtest` / `devvit upload`. Approved
domains show at
`https://developers.reddit.com/apps/ropedropplannerbot/developer-settings`. Apps that
fetch must link a Terms of Service and Privacy Policy in the app details form
(`https://ropedropplanner.com/terms-of-service`,
`https://ropedropplanner.com/privacy-policy`).

## Build and test (no Reddit login needed)

Requires Node 24.18+ (see `.nvmrc`).

```sh
cd ropedrop-bot
npm install
npm test          # typecheck + eslint + unit tests + build + devvit.json schema check
```

- `npm run test:unit` — unit tests only (`node --test`, run against the
  `tsc` output in `dist/types`).
- `npm run snapshot` — downloads the current public data bundle into
  `snapshot/` (sha256-verified) for embedding.
- `npm run build` — takes a fresh snapshot, then bundles the server (with the
  snapshot inlined) to `dist/server/index.cjs` (Vite + `@devvit/start`).
  `npm run build:offline` reuses an existing snapshot.
- `npm run check:config` — validates `devvit.json` offline with the same
  parser the Devvit CLI uses, checks the HTTP allow-list is exactly
  `ropedrop-bot-data.storage.googleapis.com`, that there are no global
  settings, that the server bundle has no `ropedropplanner.com/api/` calls,
  and that it contains the current embedded snapshot.

Tests run offline against the frozen bundle snapshot in
`test/fixtures/bundle`: parser and fuzzy-matching units (checked against
rapidfuzz reference values), the 29-post parity suite, new-intent fixtures
(including Tokyo, Hong Kong and Shanghai), the daily outlook (identical to
the Python renderer), and the Redis sync (verification, atomic flip,
fallback, garbage collection) with an in-memory Redis and fake fetch.

Business logic lives in pure modules with no Devvit imports (`src/core/*`,
`src/bot/*`, `src/bundle/*`); `engine.ts` receives Reddit, Redis, the answer
engine and the clock as injected dependencies so the tests exercise the full
decision flow with fakes.

## Deploy (owner, step by step)

See `MANUAL_CHECKLIST.md` for the full ordered list. In short:

1. `npm install`
2. `npx devvit login` (opens a browser; log in as the Reddit account that will own the app).
3. `npx devvit upload` — uploads a new version and submits the
   `ropedrop-bot-data.storage.googleapis.com` fetch domain for review.
4. Create a **private test subreddit** (e.g. r/ropedrop_bot_test) where you
   are a moderator.
5. `npx devvit playtest r/ropedrop_bot_test` — installs a dev build there and
   streams logs.
6. Check the logs for `[bundle] embedded snapshot <generation> loaded` and
   `[bundle] answering from ...` (the data in use). `[bundle] install:
{"status":"updated",...}` means the daily fetch works too; if it says
   `error` (e.g. domain not approved yet), the bot answers from the embedded
   snapshot, a retry is scheduled in 5 minutes and the nightly job keeps
   trying.
7. Test with dry run on (check logs), then turn dry run off in the test sub
   and test real replies, the mod menu, and the daily post (temporarily set
   `dailyPostHourET` to the current Eastern hour).
8. Fill in the app details on `https://developers.reddit.com/apps/ropedropplannerbot`
   (description, Terms of Service + Privacy Policy links — required because
   the app uses fetch), then `npx devvit publish` to submit for Reddit review.
   Published apps are **unlisted** by default (only you can install them),
   which is what we want. Review: ~1–2 business days for updates, longer for
   new apps that use fetch. Playtest installs only work on subreddits with
   fewer than 200 members, so a real community needs the approved version.
9. Install on r/ropedropplanner: `npx devvit install r/ropedropplanner`
   (or the Install button on `https://developers.reddit.com/apps/ropedropplannerbot`).
10. Watch `npx devvit logs r/ropedropplanner` for a day in dry run, then turn
    **Dry run** off in the install settings.

### Update

```sh
cd ropedrop-bot && git pull && npm install && npm test
npx devvit playtest r/ropedrop_bot_test   # try it in the test sub first (ctrl+c to stop)
npx devvit publish                        # every version going to r/ropedropplanner needs review
npx devvit install r/ropedropplanner      # after approval: upgrade the installation
```

Settings and Redis data survive upgrades. An upgrade re-downloads the
current bundle generation.

### Uninstall

On `https://developers.reddit.com/r/ropedropplanner/apps/ropedropplannerbot`,
choose **Uninstall** (or remove it from the subreddit's mod tools → Installed
apps). Posts and comments the bot already made stay; delete them manually if
wanted. To make the bot go quiet without uninstalling, turn **Dry run** on.

### Renaming the app

The app name (= the bot's username) is `name` in `devvit.json` (3–20 chars,
lowercase, digits, hyphens). The code discovers its own username at runtime
(`reddit.getAppUser()`), so mention detection follows automatically. Also
update `name` in `package.json`, the footer text (`BOT_DISPLAY_NAME` in
`src/core/config.ts`) and the default `feedbackUrl` if the subreddit changes.
`DEVVIT_APP_NAME=<name>` overrides the name for `devvit playtest` only.

## Design notes and deviations

- **Template:** built from Reddit's current "Mod Tool" template for Devvit Web
  (`devvit-template-mod-tool-devvit-web`, what `npm create devvit` / the
  developers.reddit.com/new wizard copies for _Mod Tool_): `devvit.json`,
  Hono server, Vite + `@devvit/start` build, no client/web view, no custom
  post. `npm create devvit@latest` itself requires a login code, so the
  template repo was copied directly (same files).
- **Triggers:** uses `onPostCreate` / `onCommentCreate` instead of
  `onPostSubmit` / `onCommentSubmit`. Per the trigger catalog, `*Create` fires
  after Reddit's safety verification while `*Submit` does not, and a post can
  fire both — so `*Create` avoids answering spam that's about to be removed.
- **Mentions:** detected from `onCommentCreate` in this subreddit. Devvit's
  `onMentionInCommentCreate` (mentions anywhere on Reddit) is limited-access
  and not used.
- **Cron time zone:** Devvit cron has no time-zone option (UTC). The job runs
  hourly (`0 * * * *`) and computes US Eastern time itself (DST rules
  built in, tested against `Intl` for a full year), posting when the Eastern
  hour is between `dailyPostHourET` and +2 hours (catch-up for a missed tick),
  guarded by a Redis `daily:<destination>:<YYYY-MM-DD>` key so it posts once
  per day. So 7:00 ET stays 7:00 ET across DST changes.
- **No backend calls:** the bot used to POST questions to
  `ropedropplanner.com/api/bot/ask` with a secret key. Reddit denies personal
  domains, so the answer logic moved into the app and the data comes from a
  public bundle; there is no key and nothing to rotate.
- **Bundle refresh cron:** `10 9-12 * * *` (UTC). The export runs at 04:15 ET;
  09:10 UTC is 05:10 EDT / 04:10 EST, so in winter the first run usually finds
  yesterday's generation and the 10:10 UTC run picks up the new one. Runs with
  an unchanged generation cost one small GET.
- **Time zones:** park-local dates for all six resorts are computed without
  ICU data (US and EU DST rules built in, checked against `Intl` in tests).
- **Tests:** the template uses Node's built-in test runner, not Vitest, so
  this app does too.
- **No `.env.example`:** the app has no secrets or environment variables.

## Docs consulted (read 2026-09-25)

- Devvit Web configuration (devvit.json): https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration
- devvit.json JSON Schema: https://developers.reddit.com/schema/config-file.v1.json
- Mod tool quickstart: https://developers.reddit.com/docs/quickstart/quickstart-mod-tool
- Template list used by the CLI: https://developers.reddit.com/templates.json
- Template library: https://developers.reddit.com/docs/examples/template-library
- Triggers: https://developers.reddit.com/docs/capabilities/server/triggers
- Trigger event catalog: https://developers.reddit.com/docs/capabilities/server/trigger-events
- App mention triggers: https://developers.reddit.com/docs/capabilities/server/global-triggers
- Settings & secrets: https://developers.reddit.com/docs/capabilities/server/settings-and-secrets
- HTTP fetch: https://developers.reddit.com/docs/capabilities/server/http-fetch
- HTTP fetch policy: https://developers.reddit.com/docs/capabilities/server/http-fetch-policy
  (and https://github.com/reddit/devvit-docs/blob/main/docs/capabilities/server/http-fetch-policy.md, read 2026-09-28)
- Redis: https://developers.reddit.com/docs/capabilities/server/redis
- Scheduler: https://developers.reddit.com/docs/capabilities/server/scheduler
- Menu actions: https://developers.reddit.com/docs/capabilities/client/menu-actions
- Toasts: https://developers.reddit.com/docs/capabilities/client/toasts
- Reddit API: https://developers.reddit.com/docs/capabilities/server/reddit-api
- Devvit CLI: https://developers.reddit.com/docs/guides/tools/devvit_cli
- Playtest: https://developers.reddit.com/docs/guides/tools/playtest
- Launch guide: https://developers.reddit.com/docs/guides/launch/launch-guide
- Devvit Rules (README, privacy/data, LLM rules): https://developers.reddit.com/docs/devvit_rules

Package versions at time of writing: `@devvit/web` / `devvit` / `@devvit/start` 0.14.5.
