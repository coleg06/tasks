import type { Env } from '../env';

/**
 * Observe-only MCP request-rate telemetry.
 *
 * Nothing is ever rejected here. When `TASKS_MCP_RATE_OBSERVE` is `true`, the server counts
 * authenticated requests per MCP client and failed client-credential attempts per fixed window,
 * and logs one `mcp.rate_observed` warning the first time a counter passes its threshold in a
 * window. The data sizes a later enforced limit without risking an agent lock-out today.
 *
 * Counters live in process memory: on Workers they are per isolate, on self-hosted Node per
 * replica, so observed counts are a lower bound of the true rate.
 */
export const MCP_RATE_OBSERVE_WINDOW_SECONDS = 60;
export const MCP_RATE_OBSERVE_DEFAULT_CLIENT_REQUESTS = 600;
export const MCP_RATE_OBSERVE_DEFAULT_FAILED_AUTH = 30;
const MAX_TRACKED_KEYS = 1_024;

type ObserveSettings = Pick<
  Env,
  | 'TASKS_MCP_RATE_OBSERVE'
  | 'TASKS_MCP_RATE_OBSERVE_CLIENT_REQUESTS'
  | 'TASKS_MCP_RATE_OBSERVE_FAILED_AUTH'
>;

export type McpRateObservation = {
  kind: 'client_requests' | 'failed_auth';
  key: string;
  count: number;
  threshold: number;
  windowSeconds: number;
};

type Bucket = { windowStart: number; count: number; reported: boolean };

function threshold(value: string | undefined, fallback: number) {
  const parsed = Number(value?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function mcpRateObservationEnabled(env: ObserveSettings) {
  return env.TASKS_MCP_RATE_OBSERVE?.trim().toLowerCase() === 'true';
}

export class McpRateObserver {
  readonly #buckets = new Map<string, Bucket>();

  /** Counts one event; returns an observation only the first time its window passes the threshold. */
  record(
    kind: McpRateObservation['kind'],
    key: string,
    limit: number,
    nowMs = Date.now(),
  ): McpRateObservation | null {
    const windowStart =
      Math.floor(nowMs / (MCP_RATE_OBSERVE_WINDOW_SECONDS * 1_000)) *
      MCP_RATE_OBSERVE_WINDOW_SECONDS;
    const id = `${kind}:${key}`;
    let bucket = this.#buckets.get(id);
    if (!bucket || bucket.windowStart !== windowStart) {
      if (!bucket && this.#buckets.size >= MAX_TRACKED_KEYS) this.#evict(windowStart);
      bucket = { windowStart, count: 0, reported: false };
      this.#buckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= limit || bucket.reported) return null;
    bucket.reported = true;
    return {
      kind,
      key,
      count: bucket.count,
      threshold: limit,
      windowSeconds: MCP_RATE_OBSERVE_WINDOW_SECONDS,
    };
  }

  #evict(windowStart: number) {
    for (const [id, bucket] of this.#buckets) {
      if (bucket.windowStart !== windowStart) this.#buckets.delete(id);
    }
    // Still full within one window: drop the oldest entry rather than grow without bound.
    if (this.#buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
  }
}

const sharedObserver = new McpRateObserver();

function report(observation: McpRateObservation | null) {
  if (!observation) return;
  console.warn(JSON.stringify({ event: 'mcp.rate_observed', ...observation }));
}

/** A request authenticated as this MCP client. */
export function observeMcpClientRequest(env: ObserveSettings, clientId: string, nowMs?: number) {
  if (!mcpRateObservationEnabled(env)) return;
  const limit = threshold(
    env.TASKS_MCP_RATE_OBSERVE_CLIENT_REQUESTS,
    MCP_RATE_OBSERVE_DEFAULT_CLIENT_REQUESTS,
  );
  report(sharedObserver.record('client_requests', clientId, limit, nowMs));
}

/**
 * A rejected client credential. Counted for the whole server: the source address depends on the
 * deployment's proxy chain, which the shared core does not know.
 */
export function observeMcpFailedAuth(env: ObserveSettings, nowMs?: number) {
  if (!mcpRateObservationEnabled(env)) return;
  const limit = threshold(
    env.TASKS_MCP_RATE_OBSERVE_FAILED_AUTH,
    MCP_RATE_OBSERVE_DEFAULT_FAILED_AUTH,
  );
  report(sharedObserver.record('failed_auth', 'all', limit, nowMs));
}
