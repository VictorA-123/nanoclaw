/**
 * Kernel event emission (Phase 3 pillar 2, step 1) — REPORTING ONLY.
 *
 * NanoClaw reports agent-run activity to the kernel's event log
 * (POST /runs to open a run, POST /events for each lifecycle event). This is
 * purely observational: every call here is fire-and-forget and swallows all
 * errors. If the kernel is down or slow, the event is DROPPED with a warning
 * and the caller continues exactly as today. Nothing here is on an agent's
 * critical path — an agent must never wait on, or fail because of, emission.
 *
 * Step 2 will add a local replay queue; step 1 simply drops on failure.
 *
 * KNOWN KERNEL-SIDE GAP: the kernel has no run-completion endpoint (only
 * POST /runs and GET /runs/:id). We record run end as a `run_ended` EVENT in the
 * events log (consistent with the events-log-is-source-of-truth design), but the
 * runs table row stays status:'started' / ended_at:null. Closing this is a
 * later kernel change — either a completion endpoint (PATCH /runs/:id) or having
 * the kernel treat a `run_ended` event as closing the run. Not solved here.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';
const EVENT_EMIT_TIMEOUT_MS = 2500;

// Pillar 2 step 2 — local queue + replay. When a POST /events fails, the event
// is appended here (one JSON object per line) instead of being dropped, and is
// re-sent (drained) on the next successful POST. Replays dedupe kernel-side via
// idempotency_key, so re-sending an already-delivered event is a harmless 409.
// Path is process.cwd()-relative — same convention as the Pillar 1 definition
// cache (cache/definitions).
const QUEUE = path.join(process.cwd(), 'cache', 'event-queue.jsonl');

// Per-run monotonic counter → deterministic idempotency_key `${run_id}:${type}:${seq}`.
// Uniqueness only has to hold within a run (kernel enforces UNIQUE(run_id,
// idempotency_key)). Pruned on run_ended so the map can't grow unbounded.
const runSeq = new Map<string, number>();

// Re-entrancy guard: at most one drain runs at a time.
let draining = false;

// POST JSON to the kernel with a hard timeout. Returns the parsed body on 2xx,
// or null on non-2xx. Throws only on network/timeout errors (callers catch).
async function postKernel(pathname: string, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVENT_EMIT_TIMEOUT_MS);
  try {
    const res = await fetch(`${KERNEL_URL}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        { pathname, status: res.status },
        'event-emit: kernel non-OK — dropping',
      );
      return null;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a run in the kernel for `agentId`. Returns the kernel-assigned run id, or
 * null if the kernel is unreachable/errored (in which case all subsequent events
 * for this run are silently skipped). Never throws.
 */
export async function emitRunStarted(
  agentId: string,
  opts: { channel?: string; invoked_by?: string; run_id?: string } = {},
): Promise<string | null> {
  if (opts.run_id) {
    // Run already opened by the caller (e.g. kernel-mediated invocation via
    // POST /agents/:id/invoke, which already ran cycle-detection + depth cap).
    // Do not open a second run for the same invocation.
    return opts.run_id;
  }
  try {
    const run = await postKernel('/runs', {
      agent_id: agentId,
      status: 'started',
      channel: opts.channel ?? null,
      invoked_by: opts.invoked_by ?? null,
    });
    return run?.id ?? null;
  } catch (err) {
    logger.warn(
      { agentId, err },
      'event-emit: run creation failed — dropping run + its events',
    );
    return null;
  }
}

/**
 * Emit one event against an open run. No-op if runId is null. `content` (inline
 * text) is stored by the kernel as a blob and referenced by content_ref; `meta`
 * is a small structured payload. Never throws.
 */
export async function emitEvent(
  runId: string | null,
  type: string,
  content?: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!runId) return;
  const run_id = runId;

  // Deterministic, per-run idempotency key so a replay dedupes kernel-side.
  const seq = (runSeq.get(run_id) ?? 0) + 1;
  runSeq.set(run_id, seq);
  const idempotency_key = `${run_id}:${type}:${seq}`;

  const payload = {
    run_id,
    type,
    content: content ?? undefined,
    meta: meta ?? undefined,
    idempotency_key,
  };

  try {
    await postKernel('/events', payload);
    // Delivered — opportunistically flush anything queued during an outage.
    void drainQueue();
  } catch (err) {
    // Kernel unreachable/timed out: persist instead of dropping (step 2).
    // The whole persist path is itself guarded so emission never throws.
    try {
      fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
      fs.appendFileSync(QUEUE, JSON.stringify(payload) + '\n');
    } catch (qerr) {
      logger.warn(
        { runId, type, err: qerr },
        'event-emit: queue append failed — dropping',
      );
    }
  } finally {
    // Prune the counter once a run ends so runSeq can't grow unbounded.
    if (type === 'run_ended') runSeq.delete(run_id);
  }
}

/**
 * Replay queued events (best-effort) once a successful POST proves the kernel is
 * reachable again. Re-POSTs each queued line IN ORDER; a 2xx OR a 409
 * (already-delivered, deduped by idempotency_key) counts as delivered. On the
 * first hard failure it STOPS and preserves that line plus the remainder, so
 * ordering is never broken. The queue is then rewritten crash-safely (temp file
 * + atomic rename) or removed if fully drained — never truncated in place.
 * Guarded by `draining`; never throws.
 */
async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    if (!fs.existsSync(QUEUE)) return;
    const lines = fs
      .readFileSync(QUEUE, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

    let i = 0;
    for (; i < lines.length; i++) {
      let delivered = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EVENT_EMIT_TIMEOUT_MS);
      try {
        const res = await fetch(`${KERNEL_URL}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: lines[i],
          signal: controller.signal,
        });
        // 409 = kernel already recorded it (idempotency_key dedup) → delivered.
        delivered = res.ok || res.status === 409;
      } catch {
        delivered = false;
      } finally {
        clearTimeout(timer);
      }
      if (!delivered) break; // stop on first failure; keep this line + the rest
    }

    const remainder = lines.slice(i);
    try {
      if (remainder.length === 0) {
        // Fully drained — remove the queue entirely.
        fs.rmSync(QUEUE, { force: true });
      } else {
        // Crash-safe: write remainder to a temp file, then atomic-rename over
        // QUEUE. Never an in-place truncate (a crash mid-write can't lose data).
        const tmp = QUEUE + '.tmp';
        fs.writeFileSync(tmp, remainder.join('\n') + '\n');
        fs.renameSync(tmp, QUEUE);
      }
    } catch (err) {
      logger.warn(
        { err },
        'event-emit: queue rewrite failed — will retry next drain',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'event-emit: drain failed');
  } finally {
    draining = false;
  }
}
