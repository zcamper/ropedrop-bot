# RopeDrop Bot — owner checklist (do these by hand, in order)

The app answers from a public data bundle it downloads itself; there is no
backend key. Commands run from the repo root on any machine with Node 24.18+.

## A. Data bundle (RopeDrop side)

- [ ] 1. Confirm the bundle is live and fresh:
      `curl -s https://ropedrop-bot-data.storage.googleapis.com/bundle/v1/manifest.json | head -c 300`
      shows `"schema":"ropedrop-bot-bundle","schema_version":1` and a
      `generated_at` from the last 24 h (nightly export at 04:15 ET).
- [ ] 2. Update `https://ropedropplanner.com/privacy-policy` (and terms if
      needed) to describe the Reddit bot: post/comment text is processed only
      inside Reddit and is never sent to RopeDrop or stored; the app only
      downloads public data files. Reddit requires ToS + Privacy links for
      apps that use fetch and won't accept links to Reddit's own policies.

## B. Reddit developer account

- [ ] 3. The app `ropedropplannerbot` (app account **u/ropedropplannerbot**)
      is already registered.
- [ ] 4. `npm ci`
- [ ] 5. `npx devvit login` (browser OAuth).
- [ ] 6. `npm test` — must pass before uploading.
- [ ] 7. `npx devvit upload` — uploads the version and submits
      `ropedrop-bot-data.storage.googleapis.com` for fetch-domain review
      (category 2: approved provider `storage.googleapis.com`, asset hosting;
      justification in README → Fetch Domains). Check status at
      `https://developers.reddit.com/apps/ropedropplannerbot/developer-settings`.
- [ ] 8. On `https://developers.reddit.com/apps/ropedropplannerbot`, fill in the
      app description and the Terms of Service
      (`https://ropedropplanner.com/terms-of-service`) and Privacy Policy
      (`https://ropedropplanner.com/privacy-policy`) links.

## C. Test in a private subreddit

- [ ] 9. Create a **private** test subreddit (e.g. r/ropedrop_bot_test, under
      200 members), you as mod. Add post flairs "Question" and "Trip Report".
- [ ] 10. `npx devvit playtest r/ropedrop_bot_test` (leave it running; it
      streams logs).
- [ ] 11. In the playtest log, look for `[bundle] install: {"status":"updated",...}`
      (or `[bundle] upgrade:`). `status":"error"` with an HTTP/network message
      means the fetch domain isn't approved yet; a retry is scheduled in 5
      minutes and the nightly `bundle-refresh` job keeps trying.
- [ ] 12. Dry-run checks (dry run is ON by default) — from a **non-mod** test
      account: - [ ] Question post → log shows `DRY RUN — would reply ...` with a sane body. - [ ] Post flaired "Trip Report" → `skipped (flair_skipped)`. - [ ] Post by a mod → `skipped (author_is_mod)`. - [ ] Comment mentioning `u/ropedropplannerbot` → dry-run reply; comment without mention → nothing. - [ ] A log line `answer engine unavailable (bundle not loaded yet)` means step 11 hasn't succeeded yet. - [ ] Try a few new question types: "How much is a Dole Whip at Magic Kingdom?", "What can a 40-inch kid ride at Disneyland?", "Is Hong Kong Disneyland busy during Chinese New Year?".
- [ ] 13. In the test sub's install settings turn **Dry run** off and repeat
      step 12: replies should appear as u/ropedropplannerbot with the footer and
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
      `https://developers.reddit.com/r/ropedropplanner/apps/ropedropplannerbot`:
      Dry run **on**, minConfidence 0.7, maxRepliesPerHour 5, skipFlairs,
      feedbackUrl, daily post 7 ET / wdw.
- [ ] 21. Watch `npx devvit logs r/ropedropplanner` for ~1 day of dry-run
      output; spot-check that the would-be replies are good.
- [ ] 22. Turn **Dry run** off. Watch logs and the first few real replies.
- [ ] 23. Optional: announce the bot in a pinned/Meta post and add a sub rule
      or wiki note on how to summon it.

## E. Later

- [ ] If the nightly export or the daily fetch stops, the bot keeps
      answering from the newest data it has (the last stored generation or
      the snapshot embedded at upload) for up to 30 days, dating its hours
      and crowd answers and staying silent on dates the data doesn't cover;
      after that it goes silent (logged as `bundle is stale`). Any upload
      (`npm run build` runs `npm run snapshot`) ships fresh embedded data.
- [ ] Updates: `npm test` → `npx devvit playtest r/ropedrop_bot_test` →
      `npx devvit publish` → `npx devvit install r/ropedropplanner`.
- [ ] Uninstall: developers.reddit.com → r/ropedropplanner → Installed apps
      → ropedropplannerbot → Uninstall. Existing bot comments/posts remain.
