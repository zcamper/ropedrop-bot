import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedApiOrigin,
  DEFAULTS,
  normalizeSettings,
  parseSkipFlairs,
  validateApiBaseUrl,
  validateHourET,
  validateHttpsUrl,
  validateMaxRepliesPerHour,
  validateMinConfidence,
} from './config.js';

void test('normalizeSettings: defaults when nothing is set (dryRun ON)', () => {
  const s = normalizeSettings({});
  assert.equal(s.apiBaseUrl, 'https://ropedropplanner.com');
  assert.equal(s.botKey, '');
  assert.equal(s.minConfidence, 0.7);
  assert.equal(s.maxRepliesPerHour, 5);
  assert.deepEqual(s.skipFlairs, ['Trip Report', 'Photo', 'Photos', 'Meta']);
  assert.equal(s.feedbackUrl, DEFAULTS.feedbackUrl);
  assert.equal(s.dailyPostEnabled, true);
  assert.equal(s.dailyPostHourET, 7);
  assert.equal(s.dailyDestination, 'wdw');
  assert.equal(s.dailyPostSticky, false);
  assert.equal(s.dryRun, true);
});

void test('normalizeSettings: clamps and coerces', () => {
  const s = normalizeSettings({
    apiBaseUrl: 'https://ropedropplanner.com/',
    botKey: '  k  ',
    minConfidence: 5,
    maxRepliesPerHour: -3,
    dailyPostHourET: '23',
    dailyDestination: ['DLR'],
    dryRun: false,
    skipFlairs: '',
  });
  assert.equal(s.apiBaseUrl, 'https://ropedropplanner.com');
  assert.equal(s.botKey, 'k');
  assert.equal(s.minConfidence, 1);
  assert.equal(s.maxRepliesPerHour, 0);
  assert.equal(s.dailyPostHourET, 23);
  assert.equal(s.dailyDestination, 'dlr');
  assert.equal(s.dryRun, false);
  assert.deepEqual(s.skipFlairs, []);
});

void test('parseSkipFlairs: comma/newline list, trimmed, deduped case-insensitively', () => {
  assert.deepEqual(parseSkipFlairs(' Meta,meta\nPhoto ,, '), ['Meta', 'Photo']);
  assert.deepEqual(parseSkipFlairs(undefined), []);
});

void test('allowedApiOrigin: only https://ropedropplanner.com', () => {
  assert.equal(
    allowedApiOrigin('https://ropedropplanner.com'),
    'https://ropedropplanner.com'
  );
  assert.equal(
    allowedApiOrigin('https://RopeDropPlanner.com/x'),
    'https://ropedropplanner.com'
  );
  assert.equal(allowedApiOrigin('http://ropedropplanner.com'), null);
  assert.equal(allowedApiOrigin('https://evil.com'), null);
  assert.equal(allowedApiOrigin('https://ropedropplanner.com.evil.com'), null);
  assert.equal(allowedApiOrigin('https://www.ropedropplanner.com'), null);
  assert.equal(allowedApiOrigin('https://u:p@ropedropplanner.com'), null);
  assert.equal(allowedApiOrigin('not a url'), null);
});

void test('validators', () => {
  assert.deepEqual(validateMinConfidence(0.7), { success: true });
  assert.equal(validateMinConfidence(0.4).success, false);
  assert.equal(validateMinConfidence(1.1).success, false);
  assert.deepEqual(validateMaxRepliesPerHour(5), { success: true });
  assert.equal(validateMaxRepliesPerHour(2.5).success, false);
  assert.deepEqual(validateHourET(0), { success: true });
  assert.equal(validateHourET(24).success, false);
  assert.deepEqual(validateHttpsUrl(DEFAULTS.feedbackUrl), { success: true });
  assert.equal(validateHttpsUrl('ftp://x').success, false);
  assert.deepEqual(validateApiBaseUrl('https://ropedropplanner.com'), {
    success: true,
  });
  assert.equal(validateApiBaseUrl('https://example.com').success, false);
});
