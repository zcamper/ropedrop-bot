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
import type { TaskResponse } from '@devvit/web/server';
import {
  validateApiBaseUrl,
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
} from './core/engine.js';
import {
  callerIsModerator,
  deps,
  loadCommentEvent,
  loadPostEvent,
} from './server/deps.js';

const app = new Hono();
const internal = new Hono();

// ---------------------------------------------------------------- triggers
// onPostCreate / onCommentCreate (not *Submit): they fire after Reddit's
// safety checks, so the bot doesn't answer content that's about to be
// removed as spam. Always return 200 — errors are logged, never posted.

internal.post('/triggers/post-create', async (c) => {
  const input = await c.req.json<OnPostCreateRequest>();
  const post = input.post;
  const outcome = await handlePost(
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
  console.log(`[trigger] post-create ${post?.id ?? '?'} -> ${outcome.status}`);
  return c.json<TriggerResponse>({}, 200);
});

internal.post('/triggers/comment-create', async (c) => {
  const input = await c.req.json<OnCommentCreateRequest>();
  const comment = input.comment;
  const outcome = await handleComment(
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
  // Most comments don't mention the bot; only log the interesting ones.
  if (!(outcome.status === 'skipped' && outcome.reason === 'no_mention')) {
    console.log(
      `[trigger] comment-create ${comment?.id ?? '?'} -> ${outcome.status}`
    );
  }
  return c.json<TriggerResponse>({}, 200);
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

// ---------------------------------------------------------------- settings validation

const validators: Record<string, (v: unknown) => SettingsValidationResponse> = {
  'min-confidence': validateMinConfidence,
  'max-replies': validateMaxRepliesPerHour,
  'hour-et': validateHourET,
  'https-url': validateHttpsUrl,
  'api-base-url': validateApiBaseUrl,
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
