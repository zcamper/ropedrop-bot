import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import type {
  MenuItemRequest,
  OnCommentCreateRequest,
  OnPostCreateRequest,
  SettingsValidationRequest,
  SettingsValidationResponse,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared';
import { scheduler, type TaskResponse } from '@devvit/web/server';
import {
  validateHourET,
  validateHttpsUrl,
  validateMaxRepliesPerHour,
  validateMinConfidence,
} from './core/config.js';
import {
  handleComment,
  handlePost,
  outcomeToast,
  runDaily,
  runWeekly,
} from './core/engine.js';
import {
  callerIsModerator,
  deps,
  describeData,
  loadCommentEvent,
  loadPostEvent,
  refreshData,
} from './server/deps.js';

const app = new Hono();
const internal = new Hono();

// ---------------------------------------------------------------- triggers
// onPostCreate / onCommentCreate (not *Submit): they fire after Reddit's
// safety checks, so the bot doesn't answer content that's about to be
// removed as spam. Always return 200 — errors are logged, never posted.

internal.post('/triggers/post-create', async (c) => {
  // handlePost logs exactly one "[bot] post ..." line per event; this catch
  // only covers a malformed trigger payload.
  try {
    const input = await c.req.json<OnPostCreateRequest>();
    const post = input.post;
    await handlePost(
      deps,
      {
        id: post?.id,
        title: post?.title,
        body: post?.selftext,
        authorName: input.author?.name,
        flairText: post?.linkFlair?.text,
        deleted: !!post?.deleted,
        spam: !!post?.spam,
      },
      'auto'
    );
  } catch (err) {
    console.error(
      `[bot] post ? mode=auto outcome=silent reason=bad_trigger_payload:${err instanceof Error ? err.name : 'error'}`
    );
  }
  return c.json<TriggerResponse>({}, 200);
});

internal.post('/triggers/comment-create', async (c) => {
  try {
    const input = await c.req.json<OnCommentCreateRequest>();
    const comment = input.comment;
    await handleComment(
      deps,
      {
        id: comment?.id,
        body: comment?.body,
        authorName: input.author?.name,
        deleted: !!comment?.deleted,
        spam: !!comment?.spam,
      },
      'auto'
    );
  } catch (err) {
    console.error(
      `[bot] comment ? mode=auto outcome=silent reason=bad_trigger_payload:${err instanceof Error ? err.name : 'error'}`
    );
  }
  return c.json<TriggerResponse>({}, 200);
});

// ---------------------------------------------------------------- data bundle
// Install / upgrade: load the data right away (the nightly job may be hours
// off). If that fails, retry in 5 minutes via a one-off scheduler job.

async function refreshOrRetry(why: string): Promise<void> {
  const r = await refreshData({ force: why === 'upgrade' });
  console.log(`[bundle] ${why}: ${JSON.stringify(r)}`);
  console.log(`[bundle] ${await describeData()}`);
  if (r.status === 'error') {
    try {
      await scheduler.runJob({
        name: 'bundle-refresh',
        runAt: new Date(Date.now() + 5 * 60_000),
      });
    } catch (err) {
      console.error(`[bundle] could not schedule a retry: ${String(err)}`);
    }
  }
}

internal.post('/triggers/app-install', async (c) => {
  await refreshOrRetry('install');
  return c.json<TriggerResponse>({}, 200);
});

internal.post('/triggers/app-upgrade', async (c) => {
  await refreshOrRetry('upgrade');
  return c.json<TriggerResponse>({}, 200);
});

// Nightly (cron, UTC) shortly after the 04:15 ET export, with retries; a run
// with an unchanged generation is one small manifest GET.
internal.post('/scheduler/bundle-refresh', async (c) => {
  const r = await refreshData();
  console.log(`[scheduler] bundle-refresh -> ${JSON.stringify(r)}`);
  console.log(`[bundle] ${await describeData()}`);
  return c.json<TaskResponse>({}, 200);
});

// ---------------------------------------------------------------- mod menu

internal.post('/menu/ask', async (c) => {
  const { targetId } = await c.req.json<MenuItemRequest>();
  try {
    // forUserType=moderator hides the item, but check server-side too.
    if (!(await callerIsModerator())) {
      return c.json<UiResponse>({ showToast: 'Moderators only.' }, 200);
    }
    const outcome = targetId.startsWith('t1_')
      ? await handleComment(deps, await loadCommentEvent(targetId), 'manual')
      : await handlePost(deps, await loadPostEvent(targetId), 'manual');
    return c.json<UiResponse>(
      {
        showToast: {
          text: outcomeToast(outcome),
          appearance: outcome.status === 'replied' ? 'success' : 'neutral',
        },
      },
      200
    );
  } catch (err) {
    console.error(`[menu] ask failed for ${targetId}: ${String(err)}`);
    return c.json<UiResponse>(
      { showToast: 'Error; did not reply. See app logs.' },
      200
    );
  }
});

// ---------------------------------------------------------------- scheduler

internal.post('/scheduler/daily-outlook', async (c) => {
  const outcome = await runDaily(deps);
  if (outcome.status !== 'skipped' || outcome.reason !== 'outside_window') {
    console.log(`[scheduler] daily-outlook -> ${JSON.stringify(outcome)}`);
  }
  return c.json<TaskResponse>({}, 200);
});

internal.post('/scheduler/weekly-posts', async (c) => {
  const outcomes = await runWeekly(deps);
  for (const o of outcomes) {
    if (o.status !== 'skipped' || !['outside_window', 'disabled'].includes(o.reason)) {
      console.log(`[scheduler] weekly-posts -> ${JSON.stringify(o)}`);
    }
  }
  return c.json<TaskResponse>({}, 200);
});

// ---------------------------------------------------------------- settings validation

const validators: Record<string, (v: unknown) => SettingsValidationResponse> = {
  'min-confidence': validateMinConfidence,
  'max-replies': validateMaxRepliesPerHour,
  'hour-et': validateHourET,
  'https-url': validateHttpsUrl,
};

internal.post('/settings/:name', async (c) => {
  const fn = validators[c.req.param('name')];
  const { value } = await c.req.json<SettingsValidationRequest<unknown>>();
  return c.json<SettingsValidationResponse>(
    fn ? fn(value) : { success: true },
    200
  );
});

app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
