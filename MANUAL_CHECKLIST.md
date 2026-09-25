# RopeDrop Bot — owner checklist (do these by hand, in order)

Nothing here has been done yet. The code builds and tests locally; it has
never talked to Reddit. Commands run from `reddit-bot/` on any machine with
Node 24.18+.

## A. Backend (RopeDrop side) — before the app can answer

- [ ] 1. Confirm the backend is live: `REDDIT_BOT_KEY` exists in GCP Secret
      Manager (project `<your-gcp-project>`) and is mounted on Cloud Run
      (`cloudbuild.yaml`), and `curl -s -o /dev/null -w '%{http_code}'
      -X POST https://ropedropplanner.com/api/bot/ask` returns **401**
      (not 503 = key not configured, not 404 = not deployed).
- [ ] 2. Update `https://ropedropplanner.com/privacy-policy` (and terms if
      needed) to describe the Reddit bot: what's sent (post/comment text),
      that it isn't stored or logged, optional Gemini wording, no training.
      Reddit requires ToS + Privacy links for apps that use fetch and won't
      accept links to Reddit's own policies.

## B. Reddit developer account

- [ ] 3. Decide which Reddit account owns the app (it becomes the developer;
      the bot posts as the separate app account **u/ropedrop-bot**). If the
      name `ropedrop-bot` is taken, change `name` in `devvit.json` +
      `package.json` (see README → Renaming).
- [ ] 4. `npm install`
- [ ] 5. `npx devvit login` (browser OAuth).
- [ ] 6. `npm test` — must pass before uploading.
- [ ] 7. `npx devvit upload` — creates the app and submits
      `ropedropplanner.com` for fetch-domain review (Reddit: usually 1–2
      business days; may be longer — their policy says personal domains need
      a detailed justification, which is in README → Fetch Domains). Check
      status at `https://developers.reddit.com/apps/ropedrop-bot/developer-settings`.
      If it is denied, reply with the README justification / contact r/Devvit
      modmail; the bot can do nothing useful without it.
- [ ] 8. On `https://developers.reddit.com/apps/ropedrop-bot`, fill in the
      app description and the Terms of Service
      (`https://ropedropplanner.com/terms-of-service`) and Privacy Policy
      (`https://ropedropplanner.com/privacy-policy`) links.

## C. Test in a private subreddit

- [ ] 9. Create a **private** test subreddit (e.g. r/ropedrop_bot_test, under
      200 members), you as mod. Add post flairs "Question" and "Trip Report".
- [ ] 10. `npx devvit playtest r/ropedrop_bot_test` (leave it running; it
      streams logs).
- [ ] 11. In another terminal: `npx devvit settings set botKey` and paste the
      value of `gcloud secrets versions access latest --secret=REDDIT_BOT_KEY
      --project <your-gcp-project>`. (Needs at least one install — step 10.)
      Never paste it into a file.
- [ ] 12. Dry-run checks (dry run is ON by default) — from a **non-mod** test
      account:
      - [ ] Question post → log shows `DRY RUN — would reply ...` with a sane body.
      - [ ] Post flaired "Trip Report" → `skipped (flair_skipped)`.
      - [ ] Post by a mod → `skipped (author_is_mod)`.
      - [ ] Comment mentioning `u/ropedrop-bot` → dry-run reply; comment without mention → nothing.
      - [ ] If the log shows `HTTP 401` the key is wrong; `HTTP 503` the backend key isn't set; `network`/`config` errors → domain not approved yet or apiBaseUrl wrong.
- [ ] 13. In the test sub's install settings turn **Dry run** off and repeat
      step 12: replies should appear as u/ropedrop-bot with the footer and
      a working Feedback link. Post the same question twice (or wait for a
      redelivery) → only one reply.
- [ ] 14. Hourly cap: set `maxRepliesPerHour` to 1, make two question posts →
      second logs `hourly cap reached`.
- [ ] 15. Mod menu: on a post and a comment, "..." → **Ask RopeDrop bot** →
      toast shows Replied / Low confidence / Already replied.
- [ ] 16. Daily post: set `dailyPostHourET` to the current US Eastern hour; at
      the next top of the hour a "Today's Crowd Outlook — ..." post appears
      (or a dry-run log). Optionally test `dailyPostSticky`. Set the hour back
      to 7 afterwards.
- [ ] 17. Stop playtest (ctrl+c).

## D. Go live on r/ropedropplanner

- [ ] 18. `npx devvit publish` (unlisted by default) and wait for Reddit's
      approval email / portal status. Every future version going to
      r/ropedropplanner also needs `publish`.
- [ ] 19. `npx devvit install r/ropedropplanner` (you need full mod
      permissions there).
- [ ] 20. Confirm install settings on
      `https://developers.reddit.com/r/ropedropplanner/apps/ropedrop-bot`:
      Dry run **on**, minConfidence 0.7, maxRepliesPerHour 5, skipFlairs,
      feedbackUrl, daily post 7 ET / wdw.
- [ ] 21. Watch `npx devvit logs r/ropedropplanner` for ~1 day of dry-run
      output; spot-check that the would-be replies are good.
- [ ] 22. Turn **Dry run** off. Watch logs and the first few real replies.
- [ ] 23. Optional: announce the bot in a pinned/Meta post and add a sub rule
      or wiki note on how to summon it.

## E. Later

- [ ] Rotate the key: new `REDDIT_BOT_KEY` version → redeploy backend →
      `npx devvit settings set botKey`.
- [ ] Updates: `npm test` → `npx devvit playtest r/ropedrop_bot_test` →
      `npx devvit publish` → `npx devvit install r/ropedropplanner`.
- [ ] Uninstall: developers.reddit.com → r/ropedropplanner → Installed apps
      → ropedrop-bot → Uninstall. Existing bot comments/posts remain.
