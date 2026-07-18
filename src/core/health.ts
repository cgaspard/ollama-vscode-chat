/**
 * The self-healing policy, expressed as a pure decision function so the timing
 * loop in the bridge stays a thin shell and the reliability rules are covered
 * by unit tests.
 *
 * Two failure modes drive everything:
 *   1. Ollama itself is unreachable (show the offline banner, wait for it).
 *   2. Ollama is up but the OpenCode server died / we lost our client
 *      (silently restart + reconnect, with backoff so we don't hammer it).
 *
 * A third state sits between them: the probe *timed out*. A saturated server
 * (mid-generation) answers slowly but isn't gone, so timeouts only flip us
 * offline after a consecutive streak — one slow probe must never pop the
 * offline banner during a long generation (LM Studio Code issue #7).
 */

/** Result of one reachability probe against the upstream server. */
export type ProbeStatus = 'ok' | 'auth-required' | 'timeout' | 'unreachable';

export interface HealthInputs {
  /** What the upstream probe returned this tick. */
  upstream: ProbeStatus;
  /** Consecutive 'timeout' probes, including this one when it timed out. */
  timeoutStreak: number;
  /** Timeouts tolerated while connected before we believe the server is gone. */
  offlineAfterTimeouts: number;
  /** Whether the bridge currently considers Ollama connected. */
  connected: boolean;
  /** OpenCode server process alive AND we hold a client for it. */
  serverHealthy: boolean;
  /** Current time (ms). */
  now: number;
  /** Earliest time we are allowed to attempt another reconnect (backoff gate). */
  nextReconnectAt: number;
  /** Poll tick counter (incremented every poll). */
  tick: number;
  /** Refresh the model list every N ticks while healthy (0 disables). */
  refreshEvery: number;
}

export type HealthAction = 'none' | 'go-offline' | 'reconnect' | 'refresh-models';

/**
 * Decide what the health poll should do this tick.
 *
 * - probe timed out              -> go-offline only after a consecutive streak
 *                                   (a busy server is not a dead server);
 *                                   never pile more requests on it meanwhile
 * - hard-down + we were online   -> go-offline (show banner)
 * - hard-down + already offline  -> none (keep waiting)
 * - up + not connected / dead    -> reconnect (once backoff allows)
 * - up + healthy, refresh tick   -> refresh-models
 * - otherwise                    -> none
 */
export function decideHealthAction(i: HealthInputs): HealthAction {
  if (i.upstream === 'timeout') {
    return i.connected && i.timeoutStreak >= i.offlineAfterTimeouts ? 'go-offline' : 'none';
  }
  if (i.upstream !== 'ok') {
    // 'unreachable' (connection refused — the server really is gone) and
    // 'auth-required' (it answered but rejected us) both flip immediately.
    return i.connected ? 'go-offline' : 'none';
  }
  // Ollama is reachable.
  if (!i.connected || !i.serverHealthy) {
    return i.now >= i.nextReconnectAt ? 'reconnect' : 'none';
  }
  if (i.refreshEvery > 0 && i.tick > 0 && i.tick % i.refreshEvery === 0) {
    return 'refresh-models';
  }
  return 'none';
}
