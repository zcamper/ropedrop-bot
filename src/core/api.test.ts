import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  askBot,
  getDailySummary,
  parseAskResponse,
  type FetchFn,
} from './api.js';

const CFG = { apiBaseUrl: 'https://ropedropplanner.com', botKey: 'test-key' };

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(
  status: number,
  body: unknown
): { fn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status }
    );
  };
  return { fn, calls };
}

void test('askBot: POSTs JSON with X-Bot-Key and truncates to 2000 chars', async () => {
  const { fn, calls } = fakeFetch(200, {
    answer: 'Go early.',
    confidence: 0.82,
    links: [{ title: 'T', url: 'https://ropedropplanner.com/x' }],
    intent: 'best_time',
  });
  const r = await askBot(fn, CFG, 'q'.repeat(5000));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://ropedropplanner.com/api/bot/ask');
  assert.equal(call.init?.method, 'POST');
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['X-Bot-Key'], 'test-key');
  assert.equal(headers['Content-Type'], 'application/json');
  const sent = JSON.parse(String(call.init?.body)) as { question: string };
  assert.equal(sent.question.length, 2000);
  if (r.ok) assert.equal(r.data.confidence, 0.82);
});

void test('askBot: 401/429/503 become http errors (no throw)', async () => {
  for (const status of [401, 429, 503]) {
    const r = await askBot(fakeFetch(status, { detail: 'x' }).fn, CFG, 'q');
    assert.deepEqual(r, { ok: false, error: { kind: 'http', status } });
  }
});

void test('askBot: network failure and bad JSON become errors', async () => {
  const boom: FetchFn = async () => {
    throw new Error('ECONNRESET');
  };
  const r1 = await askBot(boom, CFG, 'q');
  assert.equal(!r1.ok && r1.error.kind, 'network');
  const r2 = await askBot(fakeFetch(200, 'not json').fn, CFG, 'q');
  assert.equal(!r2.ok && r2.error.kind, 'bad_response');
  const r3 = await askBot(fakeFetch(200, { nope: 1 }).fn, CFG, 'q');
  assert.equal(!r3.ok && r3.error.kind, 'bad_response');
});

void test('askBot: refuses to send the key anywhere but ropedropplanner.com', async () => {
  const { fn, calls } = fakeFetch(200, {});
  const r = await askBot(
    fn,
    { apiBaseUrl: 'https://evil.example', botKey: 'k' },
    'q'
  );
  assert.equal(!r.ok && r.error.kind, 'config');
  assert.equal(calls.length, 0);
  const r2 = await askBot(fn, { apiBaseUrl: CFG.apiBaseUrl, botKey: '' }, 'q');
  assert.equal(!r2.ok && r2.error.kind, 'config');
  assert.equal(calls.length, 0);
});

void test('parseAskResponse: no_question forces confidence 0; bad links dropped', () => {
  assert.deepEqual(
    parseAskResponse({
      answer: '',
      confidence: 0.9,
      links: null,
      intent: 'no_question',
    }),
    { answer: '', confidence: 0, links: [], intent: 'no_question' }
  );
  assert.deepEqual(
    parseAskResponse({
      answer: 'a',
      confidence: 2,
      links: [{ title: 1 }, { title: 't', url: 'u' }],
      intent: 'x',
    }),
    {
      answer: 'a',
      confidence: 1,
      links: [{ title: 't', url: 'u' }],
      intent: 'x',
    }
  );
  assert.equal(parseAskResponse({ answer: 'a', confidence: 'nan' }), null);
});

void test('getDailySummary: GET with destination query and key', async () => {
  const { fn, calls } = fakeFetch(200, { markdown: '## T\n\nB' });
  const r = await getDailySummary(fn, CFG, 'wdw');
  assert.equal(r.ok, true);
  assert.equal(
    calls[0]!.url,
    'https://ropedropplanner.com/api/bot/daily-summary?destination=wdw'
  );
  assert.equal(calls[0]!.init?.method, 'GET');
});
