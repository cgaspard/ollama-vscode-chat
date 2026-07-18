import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHealthAction, HealthInputs } from '../src/core/health';

// A fully-healthy baseline; each test overrides just the fields it cares about.
const base: HealthInputs = {
  upstream: 'ok',
  timeoutStreak: 0,
  offlineAfterTimeouts: 3,
  connected: true,
  serverHealthy: true,
  now: 1000,
  nextReconnectAt: 0,
  tick: 1,
  refreshEvery: 3,
};
const decide = (over: Partial<HealthInputs>) => decideHealthAction({ ...base, ...over });

test('Ollama going away shows the offline banner exactly once', () => {
  assert.equal(decide({ upstream: 'unreachable', connected: true }), 'go-offline');
  // Already offline -> keep quietly waiting, don't thrash.
  assert.equal(decide({ upstream: 'unreachable', connected: false }), 'none');
});

test('a rejected key flips offline like an unreachable server', () => {
  assert.equal(decide({ upstream: 'auth-required', connected: true }), 'go-offline');
  assert.equal(decide({ upstream: 'auth-required', connected: false }), 'none');
});

test('probe timeouts are tolerated until the streak threshold', () => {
  // A saturated server mid-generation answers slowly — not proof it is gone.
  assert.equal(decide({ upstream: 'timeout', timeoutStreak: 1 }), 'none');
  assert.equal(decide({ upstream: 'timeout', timeoutStreak: 2 }), 'none');
  assert.equal(decide({ upstream: 'timeout', timeoutStreak: 3 }), 'go-offline');
});

test('timeouts while already offline never re-fire the banner', () => {
  assert.equal(decide({ upstream: 'timeout', timeoutStreak: 5, connected: false }), 'none');
});

test('a timeout on a refresh tick refreshes nothing (never pile on a slow server)', () => {
  assert.equal(decide({ upstream: 'timeout', timeoutStreak: 1, tick: 3 }), 'none');
});

test('Ollama returning triggers a reconnect once backoff allows', () => {
  assert.equal(decide({ connected: false, now: 5000, nextReconnectAt: 0 }), 'reconnect');
  assert.equal(decide({ connected: false, now: 1000, nextReconnectAt: 9999 }), 'none'); // backoff gate
});

test('a dead OpenCode server reconnects even while Ollama is up', () => {
  assert.equal(decide({ serverHealthy: false, now: 5000, nextReconnectAt: 0 }), 'reconnect');
  assert.equal(decide({ serverHealthy: false, now: 1000, nextReconnectAt: 9999 }), 'none');
});

test('while fully healthy, models refresh only on the cadence tick', () => {
  assert.equal(decide({ tick: 3, refreshEvery: 3 }), 'refresh-models');
  assert.equal(decide({ tick: 6, refreshEvery: 3 }), 'refresh-models');
  assert.equal(decide({ tick: 4, refreshEvery: 3 }), 'none');
  assert.equal(decide({ tick: 0, refreshEvery: 3 }), 'none');
});

test('refreshEvery=0 disables periodic refresh entirely', () => {
  assert.equal(decide({ tick: 9, refreshEvery: 0 }), 'none');
});

test('offline takes priority over the refresh cadence', () => {
  // Even on a refresh tick, if Ollama is down we surface the banner.
  assert.equal(decide({ upstream: 'unreachable', connected: true, tick: 3 }), 'go-offline');
});
