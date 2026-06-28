/**
 * Pure keep_alive helpers. Ollama's keep_alive is how long a model stays
 * resident after a request — a duration string ("5m", "1h", "8760h"), a bare
 * number of seconds, or "0"/"-1". For an interactive chat tool, "0" (unload
 * immediately) is a footgun: it makes a model you just loaded vanish. So we
 * enforce a MINIMUM keep-alive everywhere a load/chat sets one.
 */

export const MIN_KEEP_ALIVE_SECONDS = 300; // 5 minutes

/** Parse an Ollama keep_alive value to seconds. null if unparseable. */
export function parseKeepAliveSeconds(value: string | number | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const s = value.trim().toLowerCase();
  if (!s) {
    return null;
  }
  // Bare integer (incl. negative: -1 = forever).
  if (/^-?\d+$/.test(s)) {
    return Number(s);
  }
  // Duration like "30m", "1h", "1.5h", "90s", "8760h", "2d".
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(s);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return n * mult;
}

/**
 * Clamp a keep_alive to at least `minSeconds`, returning a normalized duration
 * string. A negative value (-1 = "forever") is preserved. Unparseable / too-low
 * values become the minimum. Output is minutes ("30m") or hours ("2h") when
 * even, else seconds ("90s").
 */
export function clampKeepAlive(
  value: string | number | undefined,
  minSeconds: number = MIN_KEEP_ALIVE_SECONDS,
): string {
  const secs = parseKeepAliveSeconds(value);
  if (secs != null && secs < 0) {
    return String(secs); // forever
  }
  const floored = secs == null ? minSeconds : Math.max(secs, minSeconds);
  return formatDuration(floored);
}

/** Seconds → a tidy Ollama duration string. */
function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}
