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
import { logger } from './logger.js';

const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';
const EVENT_EMIT_TIMEOUT_MS = 2500;

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
  opts: { channel?: string; invoked_by?: string } = {},
): Promise<string | null> {
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
  try {
    await postKernel('/events', {
      run_id: runId,
      type,
      content: content ?? undefined,
      meta: meta ?? undefined,
    });
  } catch (err) {
    logger.warn(
      { runId, type, err },
      'event-emit: event POST failed — dropping',
    );
  }
}
