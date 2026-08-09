import { IPC_POLL_INTERVAL } from './config.js';
import {
  findGroupByAgentId,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Kernel-mediated invocation: NanoClaw PULLS pending runs from the kernel
// instead of the kernel pushing a file into NanoClaw's filesystem. The kernel
// runs under systemd ProtectSystem=strict with ReadWritePaths limited to its
// own /opt/agent-os/data — it cannot write anywhere in /root/nanoclaw, by
// design. Pull-over-HTTP keeps that hardening intact.
const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';

export interface InvocationPollerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  onProcess: (
    chatJid: string,
    proc: import('child_process').ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  isGroupActive: (chatJid: string) => boolean;
}

interface KernelRun {
  id: string;
  agent_id: string;
  prompt: string | null;
}

let pollerRunning = false;
// Process-local dedup: run ids currently being spawned by THIS poller
// instance. A run stays status:'started' at the kernel until its container
// actually finishes (run_ended projects it to 'completed'), so without this
// set, consecutive poll ticks would re-pick-up and double-spawn the same run
// while it's still in flight.
const inProgress = new Set<string>();
// Run ids whose agent_id doesn't resolve to a registered group — permanent
// for the life of the process (no dynamic re-registration expected). Tracked
// so we warn once instead of every poll tick forever.
const warnedUnresolvable = new Set<string>();

export function startInvocationPoller(deps: InvocationPollerDeps): void {
  if (pollerRunning) {
    logger.debug('Invocation poller already running, skipping duplicate start');
    return;
  }
  pollerRunning = true;

  const poll = async () => {
    let runs: KernelRun[];
    try {
      const res = await fetch(
        `${KERNEL_URL}/runs?channel=dashboard&status=started`,
      );
      if (!res.ok) throw new Error(`kernel returned ${res.status}`);
      runs = (await res.json()) as KernelRun[];
    } catch (err) {
      logger.warn(
        { err },
        'invocation-poller: could not reach kernel, will retry',
      );
      setTimeout(poll, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const run of runs) {
      if (inProgress.has(run.id)) continue;

      const resolved = findGroupByAgentId(run.agent_id, registeredGroups);
      if (!resolved) {
        if (!warnedUnresolvable.has(run.id)) {
          logger.warn(
            { runId: run.id, agentId: run.agent_id },
            'invocation-poller: agent not resolvable to a registered group, skipping',
          );
          warnedUnresolvable.add(run.id);
        }
        continue;
      }

      const { jid: chatJid, group } = resolved;

      if (deps.isGroupActive(chatJid)) {
        // Group is mid-conversation right now. Leave it — this run stays
        // status:'started' at the kernel, so we'll see it again next tick
        // and spawn it once the group frees up. No manual recovery needed.
        continue;
      }

      inProgress.add(run.id);
      logger.info(
        { runId: run.id, agentId: run.agent_id, chatJid },
        'invocation-poller: spawning container for kernel-mediated invocation',
      );

      // Fire-and-forget per invocation (not awaited in the loop) so multiple
      // different-group invocations can spawn concurrently rather than
      // queueing behind each other inside a single poll tick.
      void (async () => {
        try {
          await runContainerAgent(
            group,
            {
              prompt: run.prompt ?? '',
              groupFolder: group.folder,
              chatJid,
              isMain: group.isMain === true,
              assistantName: group.assistantName,
              runId: run.id,
            },
            (proc, containerName) =>
              deps.onProcess(chatJid, proc, containerName, group.folder),
            async (output: ContainerOutput) => {
              // For internal agents (e.g. agent:sketch), chatJid is a synthetic key
              // like 'internal:sketch' that owns no real channel. sendMessage's
              // findChannel() lookup returns nothing for it and no-ops with a warning
              // log — this is intentional, not a bug: internal agents' output goes to
              // the kernel as events only, never to any external channel. Do not "fix"
              // that warning.
              if (output.result) {
                await deps.sendMessage(chatJid, output.result);
              }
            },
          );
        } catch (err) {
          logger.error(
            { err, runId: run.id },
            'invocation-poller: container spawn failed',
          );
        } finally {
          inProgress.delete(run.id);
        }
      })();
    }

    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
}
