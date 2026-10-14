/**
 * Drain on shutdown — FABLE ruling 2026-10-06, follow-up (g).
 * Implements docs/DRAIN_PLAN.md. Read that first; this file is the mechanism.
 *
 * On SIGTERM we refuse new work, wait a BOUNDED time for active runs to finish,
 * then stop. What we do NOT do is pretend to detach: the old
 * `GroupQueue.shutdown()` logged "containers detached, not killed" and returned,
 * and the next process's cleanupOrphans() killed those same containers 3.5
 * seconds later (STATUS follow-up (g), 2026-08-11, and again 2026-08-12). A new
 * process cannot reattach to an old container's output stream, so detaching
 * bought nothing and lost a real reply.
 *
 * Anything still running when the bound expires is stopped EXPLICITLY and its
 * run is closed with meta {"reason":"drain-timeout"} — never left to be found
 * as an orphan by the next boot.
 *
 * Every dependency is injected so the sequence can be tested without a
 * container, a kernel or a WhatsApp connection.
 */
import fs from 'fs';
import path from 'path';

import { ActiveRun } from './container-runner.js';
import { logger } from './logger.js';

/** One run that was still alive at the bound and had to be stopped. */
export interface InterruptedRun {
  containerName: string;
  groupFolder: string;
  groupName: string;
  chatJid: string;
  agentId: string | null;
  runId: string | null;
  isScheduledTask: boolean;
  taskId: string | null;
  ranForMs: number;
  at: string;
}

export interface DrainDeps {
  listRuns: () => ActiveRun[];
  /** Suppresses the close handler's own run_ended for this container. */
  markClosedByDrain: (containerName: string) => boolean;
  stopContainer: (containerName: string) => Promise<void>;
  emitRunEnded: (
    runId: string | null,
    meta: Record<string, unknown>,
  ) => Promise<void>;
  /** Drops the `_close` sentinel so a container winds down on its own. */
  closeSentinel: (groupFolder: string) => boolean;
  /** One short outbound line. Resolves even on failure; the drain bounds it. */
  notify: (chatJid: string, text: string) => Promise<void>;
  /** Persists the interrupted list for the next startup to log. */
  recordInterrupted: (runs: InterruptedRun[]) => void;
  /** Queue-managed container count — the settle wait watches this. */
  getQueueActiveCount: () => number;
  timeoutMs: number;
  settleMs: number;
  pollMs: number;
}

export interface DrainResult {
  /** True when the bound expired with runs still alive. */
  timedOut: boolean;
  interrupted: InterruptedRun[];
  waitedMs: number;
}

const RUN_ID_RESOLVE_MS = 1000;
const NOTIFY_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Resolve a promise, or give up and return `fallback`. Never rejects. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The one short line a chat gets when its run was cut off at the bound.
 * Scheduled tasks get different wording on purpose: "re-send" is not the user
 * action for a task nobody sent.
 */
export function drainNotice(run: InterruptedRun): string {
  return run.isScheduledTask
    ? 'I was restarted and a scheduled task was cut short. It will run again at its next scheduled time.'
    : 'I was restarted mid-task and lost what I was working on — please re-send your last message.';
}

/**
 * Refuse-new-work must already be in effect when this is called (see
 * GroupQueue.beginDrain() and the invocation poller's guard).
 */
export async function drainActiveRuns(deps: DrainDeps): Promise<DrainResult> {
  const start = Date.now();
  const initial = deps.listRuns();

  if (initial.length === 0) {
    logger.info('drain: no active runs — stopping immediately');
    return { timedOut: false, interrupted: [], waitedMs: 0 };
  }

  logger.info(
    {
      activeRuns: initial.length,
      containers: initial.map((r) => r.containerName),
      boundMs: deps.timeoutMs,
    },
    `drain: starting — waiting up to ${Math.round(deps.timeoutMs / 1000)}s for ${initial.length} active run(s)`,
  );

  // Step 3 — ask every active container to wind down now, rather than sitting
  // in its IPC wait until IDLE_TIMEOUT (30 minutes by default), which would
  // make every drain hit the bound. Written directly rather than through
  // GroupQueue.closeStdin(): invocation-poller spawns never set the queue's
  // `active` flag, so closeStdin() silently returns for exactly those runs.
  for (const folder of new Set(initial.map((r) => r.group.folder))) {
    if (!deps.closeSentinel(folder)) {
      logger.warn(
        { folder },
        'drain: could not write close sentinel — will stop this group at the bound',
      );
    }
  }

  // Step 4 — bounded wait.
  while (Date.now() - start < deps.timeoutMs) {
    if (deps.listRuns().length === 0) {
      const waitedMs = Date.now() - start;
      logger.info({ waitedMs }, 'drain: all active runs finished');
      await settle(deps);
      return { timedOut: false, interrupted: [], waitedMs };
    }
    await sleep(deps.pollMs);
  }

  // Step 5 — the bound expired. In parallel, because `docker stop` and the
  // kernel POST are each seconds long and the unit only grants 30s of headroom
  // over the bound.
  const remaining = deps.listRuns();
  const at = new Date().toISOString();
  const interrupted = await Promise.all(
    remaining.map(async (run): Promise<InterruptedRun> => {
      // (a) BEFORE stopping, so the close handler does not emit a second
      //     run_ended and leave the transcript with two endings.
      deps.markClosedByDrain(run.containerName);

      // (b) close the run honestly, through the normal emitter — idempotency
      //     keyed, queued on a kernel outage, projected onto runs.status.
      const runId = await withTimeout(
        run.runIdPromise,
        RUN_ID_RESOLVE_MS,
        null as string | null,
      );
      try {
        await deps.emitRunEnded(runId, { reason: 'drain-timeout' });
      } catch (err) {
        logger.warn(
          { containerName: run.containerName, runId, err },
          'drain: could not emit run_ended — the startup reconciler will close it',
        );
      }

      // (c) explicit stop. Never a silent orphan for the next boot to find.
      try {
        await deps.stopContainer(run.containerName);
      } catch (err) {
        logger.warn(
          { containerName: run.containerName, err },
          'drain: container stop failed',
        );
      }

      const entry: InterruptedRun = {
        containerName: run.containerName,
        groupFolder: run.group.folder,
        groupName: run.group.name,
        chatJid: run.chatJid,
        agentId: run.agentId,
        runId,
        isScheduledTask: run.isScheduledTask,
        taskId: run.taskId,
        ranForMs: Date.now() - run.startedAt,
        at,
      };

      // (d) one WARN per container.
      logger.warn(
        entry,
        `drain: stopped ${run.containerName} at the ${Math.round(deps.timeoutMs / 1000)}s bound (run ${runId ?? 'unreported'}, ran ${Math.round(entry.ranForMs / 1000)}s)`,
      );
      return entry;
    }),
  );

  deps.recordInterrupted(interrupted);

  // Tell the chat, once per interrupted run, and settle at the same time — the
  // settle window is dead waiting otherwise, and both are bounded.
  await Promise.all([
    notifyAll(deps, interrupted),
    // Step 6 — give the awaiting callers room for their own bookkeeping: the
    // message-cursor rollback in processGroupMessages (which is what makes the
    // message recoverable after restart) and updateTaskAfterRun for a task.
    settle(deps),
  ]);

  return { timedOut: true, interrupted, waitedMs: Date.now() - start };
}

async function notifyAll(
  deps: DrainDeps,
  interrupted: InterruptedRun[],
): Promise<void> {
  await Promise.all(
    interrupted.map(async (run) => {
      // Internal agents (agent:sketch and friends) have a synthetic chatJid
      // that owns no channel. notify() no-ops for those.
      await withTimeout(
        deps.notify(run.chatJid, drainNotice(run)).catch((err) => {
          logger.warn(
            { chatJid: run.chatJid, err },
            'drain: could not send the restart notice',
          );
        }),
        NOTIFY_TIMEOUT_MS,
        undefined,
      );
    }),
  );
}

/** Wait briefly for queue-managed callers to finish their own bookkeeping. */
async function settle(deps: DrainDeps): Promise<void> {
  const until = Date.now() + deps.settleMs;
  while (Date.now() < until) {
    if (deps.getQueueActiveCount() === 0) return;
    await sleep(deps.pollMs);
  }
  logger.warn(
    { queueActive: deps.getQueueActiveCount(), settleMs: deps.settleMs },
    'drain: settle window expired with queue work still unwinding',
  );
}

// --- Interrupted-run report ---------------------------------------------------
// Written at drain-timeout, read + logged + deleted at the next startup.
// Decision: a drain-killed scheduled task is NOT rescheduled — it simply moves
// to its next scheduled slot through the normal error path — but it must not
// vanish silently, so the next boot says out loud what got cut off.
//
// cache/ is the same convention the definition cache and the kernel event queue
// already use: regenerable runtime state, not data.

const INTERRUPTED_FILE = (): string =>
  path.join(process.cwd(), 'cache', 'drain-interrupted.json');

export function recordInterruptedRuns(runs: InterruptedRun[]): void {
  if (runs.length === 0) return;
  try {
    const file = INTERRUPTED_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(runs, null, 2) + '\n');
  } catch (err) {
    logger.warn({ err }, 'drain: could not write the interrupted-run report');
  }
}

/**
 * Startup side: log what the previous drain had to cut off, then clear it.
 * Returns the entries, for tests.
 */
export function reportInterruptedRuns(): InterruptedRun[] {
  const file = INTERRUPTED_FILE();
  let runs: InterruptedRun[] = [];
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    runs = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn({ err }, 'drain: could not read the interrupted-run report');
    runs = [];
  }

  for (const run of runs) {
    if (run.isScheduledTask) {
      logger.warn(
        run,
        `drain: scheduled task ${run.taskId ?? '(unknown id)'} in ${run.groupName} was cut short by the last restart and was NOT rescheduled — it runs again at its next scheduled time`,
      );
    } else {
      logger.warn(
        run,
        `drain: ${run.groupName}'s run was cut short by the last restart (run ${run.runId ?? 'unreported'}); its messages were left unconsumed and are recovered below`,
      );
    }
  }

  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    logger.warn({ err }, 'drain: could not clear the interrupted-run report');
  }
  return runs;
}
