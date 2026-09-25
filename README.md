# RopeDrop Bot (`ropedrop-bot`)

## Overview

RopeDrop Bot is a Reddit app for **r/ropedropplanner**, a community about
planning Disney theme-park days. It helps people with the questions that come
up again and again ("When is Slinky Dog shortest?", "Is EPCOT busy on
Friday?") by answering from RopeDrop Planner's historical and live wait-time
data.

What it does:

1. **Answers new posts.** When someone creates a post, the bot sends the
   title and body to the RopeDrop Planner API. If the API is confident in its
   answer (70% by default), the bot replies with the answer, up to three
   links, and a short footer with a feedback link. If it isn't confident, the
   bot stays silent.
2. **Answers when summoned.** A comment that mentions `u/ropedrop-bot` is
   treated as a question (the mention is removed first). Other comments are
   ignored.
3. **Posts a daily "Today's Crowd Outlook"** each morning (7:00 AM US Eastern
   by default) with the expected crowd level, park hours and a rope-drop
   pick for each park.
4. **Gives moderators an "Ask RopeDrop bot" menu item** on posts and comments
   to request an answer on demand.

Who it's for: members of r/ropedropplanner who want a quick, data-based answer,
and moderators who want the repetitive questions answered consistently.

Safety and operational notes:

- **Dry run is ON after install.** Until a moderator turns off *Dry run*, the
  bot only writes to the app logs what it *would* post. Nothing appears on Reddit.
- It never replies twice to the same post or comment, and it sends at most
  **5 automatic replies per rolling hour** (configurable).
- It skips posts by moderators, its own posts, removed/deleted content, and
  posts flaired *Trip Report*, *Photo*, *Photos* or *Meta* (configurable).
- If the RopeDrop Planner API is unavailable or rejects the request, the bot
  logs it and does nothing. It never posts an error message.
- It stores **no Reddit content**. Redis only holds post/comment IDs (for
  duplicate protection, expiring after 30 days), a rolling list of reply IDs
  for the hourly cap (expires after 2 hours), and a "posted today" marker for
  the daily post (expires after 3 days).

## How it works

```
                          r/ropedropplanner
 new post ─────────────┐        │        ┌──────── mod clicks "Ask RopeDrop bot"
 new comment ──────────┤        │        │              (post or comment menu)
  (only if u/bot       │        │        │
   is mentioned)       ▼        ▼        ▼
                ┌──────────────────────────────────────────┐
                │ Devvit app  (Devvit Web, server-only)     │
                │  src/index.ts          Hono routes        │
                │  src/core/engine.ts    decide + reply     │
                │  src/core/logic.ts     pure rules/format  │
                │  src/core/api.ts       backend client     │
                │  src/server/deps.ts    Reddit/Redis/fetch │
                └──┬───────────────┬───────────────┬───────┘
    filters:       │  Redis        │ HTTPS fetch   │ Reddit API (as the app account)
    bot? mod?      │  replied:<id> │ (allow-list:  │  submitComment (reply)
    removed?       │  lock:<id>    │ ropedropplanner.com only)
    flair skip?    │  replies:window (cap)         │  submitPost (daily outlook)
    mention?       │  daily:<dest>:<date>          │
                   ▼               ▼               ▼
                 dedupe      POST /api/bot/ask            ┌─ hourly cron "0 * * * *" (UTC)
                 + cap       GET  /api/bot/daily-summary ◄┘  posts once when it's the
                             header X-Bot-Key: <secret>       target hour in US Eastern
```

Reply decision, in order: already replied? → hourly cap (automatic replies
only) → in-flight lock → still visible on Reddit? → ask the API → confidence
≥ threshold? → dry run? (log) → post the reply → record the id.

Reply format:

```
<answer>

- [link title](url)        (up to 3)

---
^(I'm the RopeDrop Planner bot, answering from our wait-time data.) [^(Feedback)](<feedback link>)
```

## Settings

Subreddit settings are edited by moderators on the app's install settings
page (`https://developers.reddit.com/r/ropedropplanner/apps/ropedrop-bot`).
Global settings are set by the app developer with the Devvit CLI.

| Setting | Scope | Default | What it does |
|---|---|---|---|
| `botKey` | global, **secret** | *(none)* | Value of the `X-Bot-Key` header. Set with `npx devvit settings set botKey`. |
| `apiBaseUrl` | global | `https://ropedropplanner.com` | Backend base URL. Must be https on `ropedropplanner.com` (the only allow-listed domain; the key is never sent anywhere else). |
| `dryRun` | subreddit | **on** | Log what would be posted instead of posting. Turn off to go live. |
| `minConfidence` | subreddit | `0.7` | Minimum API confidence for an automatic reply (0.5–1). |
| `maxRepliesPerHour` | subreddit | `5` | Max automatic replies in any rolling 60 minutes (0–60). Only real replies count. |
| `skipFlairs` | subreddit | `Trip Report, Photo, Photos, Meta` | Comma-separated post flairs to ignore (exact match, case-insensitive). Applies to automatic post replies. |
| `feedbackUrl` | subreddit | modmail compose link for r/ropedropplanner | Link behind "Feedback" in the footer. |
| `dailyPostEnabled` | subreddit | on | Post "Today's Crowd Outlook" daily. |
| `dailyPostHourET` | subreddit | `7` | Hour (0–23, US Eastern) for the daily post. |
| `dailyDestination` | subreddit | `wdw` | `wdw` (Walt Disney World) or `dlr` (Disneyland Resort). |
| `dailyPostSticky` | subreddit | off | Distinguish and sticky the daily post (slot 1). |

Mod menu "Ask RopeDrop bot": ignores the flair skip list, the moderator-author
rule and the hourly cap, but still requires confidence ≥ **0.5** (hard floor)
and still never replies twice. Its toast says *Replied*, *Low confidence*,
*Already replied*, *Dry run*, *Skipped* or *Error*.

### Secrets

`botKey` must equal the backend's `REDDIT_BOT_KEY`, stored in GCP Secret
Manager (project `<your-gcp-project>`, secret `REDDIT_BOT_KEY`). The owner reads
it (`gcloud secrets versions access latest --secret=REDDIT_BOT_KEY --project <your-gcp-project>`)
and pastes it into `npx devvit settings set botKey`. **Never commit it** and
never put it in `devvit.json`, `.env` or any file in this repo. To rotate:
add a new secret version, redeploy the backend, then run
`npx devvit settings set botKey` again.

Devvit rule: secrets are **global only** and can **only** be set by the app
developer via the CLI, not on the moderator settings page, and only after the
app has been installed at least once.

## Fetch Domains

The following domain is requested for this app:

- `ropedropplanner.com` — the RopeDrop Planner API (`/api/bot/ask` and
  `/api/bot/daily-summary`). It turns a park-planning question into an answer
  computed from RopeDrop Planner's own wait-time and crowd data, and supplies
  the daily crowd outlook. Only the question text (post title + body, or the
  summoning comment without the mention) is sent; no usernames or IDs. The
  API does not store or log question text. Answers are composed from
  RopeDrop's data (optionally worded by Google Gemini, an approved LLM
  provider); Reddit data is never used to train models.

Domain approval: domains listed in `devvit.json` → `permissions.http.domains`
are submitted for review automatically on the first `devvit playtest` or
`devvit upload`. Reddit says most requests are reviewed within **1–2 business
days**, longer if there's policy ambiguity. Approved domains show at
`https://developers.reddit.com/apps/ropedrop-bot/developer-settings`. Until
approval, calls to the API fail (logged, nothing posted).

Note: Reddit's fetch policy says personal domains "will not be approved"
without a detailed justification, and apps that fetch must link a Terms of
Service and Privacy Policy in the app details form (use
`https://ropedropplanner.com/terms-of-service` and
`https://ropedropplanner.com/privacy-policy`; the privacy policy should
mention this bot).

## Build and test (no Reddit login needed)

Requires Node 24.18+ (see `.nvmrc`).

```sh
cd reddit-bot
npm install
npm test          # typecheck + eslint + unit tests + build + devvit.json schema check
```

- `npm run test:unit` — unit tests only (`node --test`, run against the
  `tsc` output in `dist/types`).
- `npm run build` — bundles the server to `dist/server/index.cjs` (Vite +
  `@devvit/start`).
- `npm run check:config` — validates `devvit.json` offline with the same
  parser the Devvit CLI uses, and checks the HTTP allow-list is exactly
  `ropedropplanner.com`.

Business logic lives in pure modules with no Devvit imports
(`src/core/{config,logic,time,api,engine}.ts`); `engine.ts` receives Reddit,
Redis, HTTP and the clock as injected dependencies so the tests exercise the
full decision flow with fakes.

## Deploy (owner, step by step)

See `MANUAL_CHECKLIST.md` for the full ordered list. In short:

1. `npm install`
2. `npx devvit login` (opens a browser; log in as the Reddit account that will own the app).
3. `npx devvit upload` — creates the app `ropedrop-bot` (and its app account
   **u/ropedrop-bot**) and submits the `ropedropplanner.com` fetch domain for
   review.
4. Create a **private test subreddit** (e.g. r/ropedrop_bot_test) where you
   are a moderator.
5. `npx devvit playtest r/ropedrop_bot_test` — installs a dev build there and
   streams logs.
6. `npx devvit settings set botKey` — paste the `REDDIT_BOT_KEY` value.
7. Test with dry run on (check logs), then turn dry run off in the test sub
   and test real replies, the mod menu, and the daily post (temporarily set
   `dailyPostHourET` to the current Eastern hour).
8. Fill in the app details on `https://developers.reddit.com/apps/ropedrop-bot`
   (description, Terms of Service + Privacy Policy links — required because
   the app uses fetch), then `npx devvit publish` to submit for Reddit review.
   Published apps are **unlisted** by default (only you can install them),
   which is what we want. Review: ~1–2 business days for updates, longer for
   new apps that use fetch. Playtest installs only work on subreddits with
   fewer than 200 members, so a real community needs the approved version.
9. Install on r/ropedropplanner: `npx devvit install r/ropedropplanner`
   (or the Install button on `https://developers.reddit.com/apps/ropedrop-bot`).
10. Watch `npx devvit logs r/ropedropplanner` for a day in dry run, then turn
    **Dry run** off in the install settings.

### Update

```sh
cd reddit-bot && git pull && npm install && npm test
npx devvit playtest r/ropedrop_bot_test   # try it in the test sub first (ctrl+c to stop)
npx devvit publish                        # every version going to r/ropedropplanner needs review
npx devvit install r/ropedropplanner      # after approval: upgrade the installation
```

Settings and Redis data survive upgrades.

### Uninstall

On `https://developers.reddit.com/r/ropedropplanner/apps/ropedrop-bot`,
choose **Uninstall** (or remove it from the subreddit's mod tools → Installed
apps). Posts and comments the bot already made stay; delete them manually if
wanted. To stop the backend from answering at all, delete/rotate
`REDDIT_BOT_KEY` on the server (every call then gets 401/503 and the bot stays
silent).

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
  developers.reddit.com/new wizard copies for *Mod Tool*): `devvit.json`,
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
- **Secrets:** `botKey` is a global secret set by CLI (Devvit does not allow
  subreddit-scoped secrets or setting secrets in the install UI).
  `apiBaseUrl` is global too so a subreddit setting can't redirect the key.
- **Tests:** the template uses Node's built-in test runner, not Vitest, so
  this app does too.
- **No `.env.example`:** the template doesn't use one; secrets go through
  `devvit settings set`.

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
