import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampKeepAlive, MIN_KEEP_ALIVE_SECONDS, parseKeepAliveSeconds } from '../src/core/keepAlive';

test('parseKeepAliveSeconds parses durations, bare seconds, and specials', () => {
  assert.equal(parseKeepAliveSeconds('30m'), 1800);
  assert.equal(parseKeepAliveSeconds('1h'), 3600);
  assert.equal(parseKeepAliveSeconds('90s'), 90);
  assert.equal(parseKeepAliveSeconds('2d'), 172800);
  assert.equal(parseKeepAliveSeconds('0'), 0);
  assert.equal(parseKeepAliveSeconds('-1'), -1);
  assert.equal(parseKeepAliveSeconds(300), 300);
  assert.equal(parseKeepAliveSeconds('nonsense'), null);
  assert.equal(parseKeepAliveSeconds(''), null);
  assert.equal(parseKeepAliveSeconds(undefined), null);
});

test('clampKeepAlive floors 0 / too-small / unparseable to the 5m minimum', () => {
  assert.equal(MIN_KEEP_ALIVE_SECONDS, 300);
  assert.equal(clampKeepAlive('0'), '5m'); // the footgun: 0 → 5m, never unload-immediately
  assert.equal(clampKeepAlive('0s'), '5m');
  assert.equal(clampKeepAlive('1m'), '5m'); // below the floor
  assert.equal(clampKeepAlive('90s'), '5m');
  assert.equal(clampKeepAlive(''), '5m');
  assert.equal(clampKeepAlive(undefined), '5m');
  assert.equal(clampKeepAlive('garbage'), '5m');
});

test('clampKeepAlive preserves values at or above the floor', () => {
  assert.equal(clampKeepAlive('5m'), '5m');
  assert.equal(clampKeepAlive('30m'), '30m');
  assert.equal(clampKeepAlive('1h'), '1h');
  assert.equal(clampKeepAlive('8760h'), '8760h'); // "forever"-ish
});

test('clampKeepAlive preserves a negative ("forever") value', () => {
  assert.equal(clampKeepAlive('-1'), '-1');
  assert.equal(clampKeepAlive(-1), '-1');
});

test('clampKeepAlive honors a custom minimum', () => {
  assert.equal(clampKeepAlive('30s', 60), '1m');
  assert.equal(clampKeepAlive('5m', 60), '5m');
});
