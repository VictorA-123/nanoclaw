import { execSync } from 'node:child_process';
import { AGENT_IDS } from './container-runner.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { emitEvent } from './kernel-events.js';
import { logger } from './logger.js';

const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';

// Is any container for this group currently up? Same `ps --filter name= --format
// '{{.Names}}'` shape cleanupOrphans() uses, narrowed from the shared `nanoclaw-`
// prefix to this one group. Names are `nanoclaw-<safeName>-<timestamp>` with
// safeName built exactly as container-runner.ts does at spawn. `name=` is a
// SUBSTRING match, so the trailing dash is deliberate: it stops a group from
// matching one whose name merely starts with the same text (`main` vs `main2`).
// It does NOT separate a future `<folder>_<suffix>` group — that would match
// this prefix and make us skip; conservative in the safe direction (we decline
// to close runs), but re-check this if a group is ever named that way.
//
// FAILS CLOSED: if the check itself throws we report "running", so the caller
// skips the agent rather than closing runs while blind to container state.
function hasRunningContainer(folder: string): boolean {
  const safeName = folder.replace(/[^a-zA-Z0-9-]/g, '-');
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw-${safeName}- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    return output.trim().split('\n').filter(Boolean).length > 0;
  } catch (err) {
    logger.warn(
      { folder, err },
      'startup-reconcile: container check failed — treating as running',
    );
    return true;
  }
}

export async function reconcileOrphanedRuns(): Promise<void> {
  for (const [folder, agentId] of Object.entries(AGENT_IDS)) {
    try {
      // B-Q3 closes only runs with NO live container. A run carries no container
      // name in the kernel schema, so exact run→container matching is impossible;
      // stay conservative at the AGENT level — if any container for this group is
      // up, skip the agent entirely rather than guess which run owns it. That
      // keeps this correct on the ruling's stated condition rather than merely
      // correct today: it does not depend on cleanupOrphans() having killed
      // everything first, so follow-up (g)'s "spare detached containers" fix can
      // land without touching this file.
      if (hasRunningContainer(folder)) {
        logger.info(
          { agentId, folder },
          'startup-reconcile: live container for group — skipping agent this cycle',
        );
        continue;
      }
      const url =
        KERNEL_URL +
        '/runs?agent_id=' +
        encodeURIComponent(agentId) +
        '&status=started';
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      // res.json() is typed unknown — GET /runs returns run rows (plus a
      // resolved `prompt`); only the id is needed here.
      const runs = (await res.json()) as Array<{ id: string }>;
      for (const run of runs) {
        await emitEvent(run.id, 'run_ended', undefined, {
          reason: 'orphaned-on-restart',
        });
        logger.info(
          { runId: run.id, agentId: agentId },
          'Reconciled orphaned run on startup',
        );
      }
    } catch (err) {
      logger.warn(
        { agentId: agentId, err: err },
        'startup-reconcile failed for one agent',
      );
    }
  }
}
