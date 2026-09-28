import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULTS,
  normalizeSettings,
  parseSkipFlairs,
  validateHourET,
  validateHttpsUrl,
  validateMaxRepliesPerHour,
  validateMinConfidence,
} from './config.js';

void test('normalizeSettings: defaults when nothing is set (dryRun ON)', () => {
  const s = normalizeSettings({});
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
    minConfidence: 5,
    maxRepliesPerHour: -3,
    dailyPostHourET: '23',
    dailyDestination: ['DLR'],
    dryRun: false,
    skipFlairs: '',
  });
  assert.equal('apiBaseUrl' in s, false);
  assert.equal('botKey' in s, false);
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
});
