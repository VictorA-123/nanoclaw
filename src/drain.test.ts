/**
 * Drain on shutdown (follow-up (g)) — docs/DRAIN_PLAN.md.
 *
 * Every dependency is injected, so none of this touches a container, the
 * kernel, WhatsApp, or the live cache/ directory. The report round-trip runs
 * under a scratch cwd.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { ActiveRun } from './container-runner.js';
import {
  drainActiveRuns,
  drainNotice,
  DrainDeps,
  InterruptedRun,
  recordInterruptedRuns,
  reportInterruptedRuns,
} from './drain.js';
import { logger } from './logger.js';

function makeRun(over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    containerName: 'nanoclaw-whatsapp-main-1',
    group: {
      name: 'Jammer',
      folder: 'whatsapp_main',
      trigger: '',
      added_at: new Date(0).toISOString(),
      isMain: true,
    },
    chatJid: '123@g.us',
    agentId: 'agent:jammer',
    runIdPromise: Promise.resolve('run:abc'),
    isScheduledTask: false,
    taskId: null,
    startedAt: Date.now() - 5_000,
    closedByDrain: false,
    ...over,
  };
}

interface Harness {
  deps: DrainDeps;
  calls: string[];
  stopped: string[];
  emitted: Array<{ runId: string | null; meta: Record<string, unknown> }>;
  sentinels: string[];
  notices: Array<{ chatJid: string; text: string }>;
  recorded: InterruptedRun[][];
}

function harness(runs: ActiveRun[], over: Partial<DrainDeps> = {}): Harness {
  const live = new Set(runs);
  const h: Partial<Harness> = {
    calls: [],
    stopped: [],
    emitted: [],
    sentinels: [],
    notices: [],
    recorded: [],
  };
  const deps: DrainDeps = {
    listRuns: () => [...live],
    markClosedByDrain: (name) => {
      h.calls!.push(`mark:${name}`);
      return true;
    },
    stopContainer: async (name) => {
      h.calls!.push(`stop:${name}`);
      h.stopped!.push(name);
      for (const r of live) if (r.containerName === name) live.delete(r);
    },
    emitRunEnded: async (runId, meta) => {
      h.calls!.push(`emit:${runId}`);
      h.emitted!.push({ runId, meta });
    },
    closeSentinel: (folder) => {
      h.sentinels!.push(folder);
      return true;
    },
    notify: async (chatJid, text) => {
      h.notices!.push({ chatJid, text });
    },
    recordInterrupted: (entries) => {
      h.recorded!.push(entries);
    },
    getQueueActiveCount: () => 0,
    timeoutMs: 60,
    settleMs: 20,
    pollMs: 5,
    ...over,
  };
  return { ...(h as Harness), deps };
}

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

describe('drainActiveRuns', () => {
  it('returns immediately when nothing is running', async () => {
    const h = harness([]);
    const res = await drainActiveRuns(h.deps);
    expect(res).toEqual({ timedOut: false, interrupted: [], waitedMs: 0 });
    expect(h.sentinels).toEqual([]);
    expect(h.stopped).toEqual([]);
  });

  it('asks every active group to wind down, once per folder', async () => {
    const runs = [
      makeRun({ containerName: 'a' }),
      makeRun({ containerName: 'b' }), // same folder
      makeRun({
        containerName: 'c',
        group: {
          name: 'Haddock',
          folder: 'whatsapp_builder',
          trigger: '',
          added_at: '',
          isMain: false,
        },
      }),
    ];
    const live = [...runs];
    const h = harness(runs, { listRuns: () => live });
    const p = drainActiveRuns(h.deps);
    // let the sentinels be written, then let everything finish
    await new Promise((r) => setTimeout(r, 10));
    live.length = 0;
    await p;
    expect(h.sentinels).toEqual(['whatsapp_main', 'whatsapp_builder']);
  });

  it('finishes cleanly when runs end before the bound — nothing stopped', async () => {
    const live = [makeRun()];
    const h = harness(live, { listRuns: () => live });
    const p = drainActiveRuns(h.deps);
    setTimeout(() => (live.length = 0), 10);
    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.interrupted).toEqual([]);
    expect(h.stopped).toEqual([]);
    expect(h.emitted).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('at the bound: marks drain-closed BEFORE stopping, and closes the run', async () => {
    const h = harness([makeRun({ containerName: 'nc-1' })]);
    const res = await drainActiveRuns(h.deps);

    expect(res.timedOut).toBe(true);
    // Ordering is the whole point: mark first, so the container's own close
    // handler does not emit a second run_ended.
    expect(h.calls.indexOf('mark:nc-1')).toBeLessThan(
      h.calls.indexOf('stop:nc-1'),
    );
    expect(h.emitted).toEqual([
      { runId: 'run:abc', meta: { reason: 'drain-timeout' } },
    ]);
    expect(h.stopped).toEqual(['nc-1']);
  });

  it('records the interrupted run and warns naming the container', async () => {
    const h = harness([
      makeRun({ containerName: 'nc-1', taskId: null, isScheduledTask: false }),
    ]);
    const res = await drainActiveRuns(h.deps);

    expect(res.interrupted).toHaveLength(1);
    expect(res.interrupted[0]).toMatchObject({
      containerName: 'nc-1',
      groupFolder: 'whatsapp_main',
      agentId: 'agent:jammer',
      runId: 'run:abc',
      isScheduledTask: false,
    });
    expect(h.recorded).toEqual([res.interrupted]);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some((c) => String(c[1]).includes('nc-1')),
    ).toBe(true);
  });

  it('sends one short outbound line per interrupted run', async () => {
    const h = harness([makeRun({ chatJid: '123@g.us' })]);
    await drainActiveRuns(h.deps);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].chatJid).toBe('123@g.us');
    expect(h.notices[0].text).toContain('re-send');
  });

  it('uses task wording for a scheduled task, not "re-send"', async () => {
    const h = harness([makeRun({ isScheduledTask: true, taskId: 'task-7' })]);
    const res = await drainActiveRuns(h.deps);
    expect(res.interrupted[0].taskId).toBe('task-7');
    expect(h.notices[0].text).not.toContain('re-send');
    expect(h.notices[0].text).toContain('next scheduled time');
  });

  it('stops the container even when the kernel emit fails', async () => {
    const h = harness([makeRun({ containerName: 'nc-1' })], {
      emitRunEnded: async () => {
        throw new Error('kernel down');
      },
    });
    const res = await drainActiveRuns(h.deps);
    expect(res.timedOut).toBe(true);
    expect(h.stopped).toEqual(['nc-1']);
  });

  it('survives a notify failure', async () => {
    const h = harness([makeRun()], {
      notify: async () => {
        throw new Error('whatsapp gone');
      },
    });
    await expect(drainActiveRuns(h.deps)).resolves.toMatchObject({
      timedOut: true,
    });
  });

  it('records a null runId when the run was never reported to the kernel', async () => {
    const h = harness([
      makeRun({ agentId: null, runIdPromise: Promise.resolve(null) }),
    ]);
    const res = await drainActiveRuns(h.deps);
    expect(res.interrupted[0].runId).toBeNull();
    expect(h.emitted).toEqual([
      { runId: null, meta: { reason: 'drain-timeout' } },
    ]);
  });

  it('settle waits for queue bookkeeping, then gives up loudly', async () => {
    const h = harness([makeRun()], {
      getQueueActiveCount: () => 1, // never unwinds
      settleMs: 20,
    });
    await drainActiveRuns(h.deps);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some((c) => String(c[1]).includes('settle window expired')),
    ).toBe(true);
  });
});

describe('drainNotice', () => {
  const base: InterruptedRun = {
    containerName: 'x',
    groupFolder: 'f',
    groupName: 'G',
    chatJid: 'j',
    agentId: null,
    runId: null,
    isScheduledTask: false,
    taskId: null,
    ranForMs: 1,
    at: '',
  };
  it('asks for a re-send on a message run', () => {
    expect(drainNotice(base)).toContain('re-send');
  });
  it('does not ask for a re-send on a scheduled task', () => {
    expect(drainNotice({ ...base, isScheduledTask: true })).not.toContain(
      're-send',
    );
  });
});

describe('interrupted-run report', () => {
  let cwd: string;
  let scratch: string;

  beforeEach(() => {
    cwd = process.cwd();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-drain-'));
    process.chdir(scratch);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const entry = (over: Partial<InterruptedRun> = {}): InterruptedRun => ({
    containerName: 'nc-1',
    groupFolder: 'whatsapp_main',
    groupName: 'Jammer',
    chatJid: '123@g.us',
    agentId: 'agent:jammer',
    runId: 'run:abc',
    isScheduledTask: false,
    taskId: null,
    ranForMs: 1000,
    at: '2026-10-14T00:00:00.000Z',
    ...over,
  });

  it('writes nothing when there is nothing to record', () => {
    recordInterruptedRuns([]);
    expect(fs.existsSync(path.join(scratch, 'cache'))).toBe(false);
    expect(reportInterruptedRuns()).toEqual([]);
  });

  it('round-trips, logs, and clears the file', () => {
    recordInterruptedRuns([
      entry(),
      entry({ isScheduledTask: true, taskId: 't9' }),
    ]);
    const file = path.join(scratch, 'cache', 'drain-interrupted.json');
    expect(fs.existsSync(file)).toBe(true);

    const read = reportInterruptedRuns();
    expect(read).toHaveLength(2);
    // The scheduled task is called out as NOT rescheduled.
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some(
          (c) =>
            String(c[1]).includes('t9') &&
            String(c[1]).includes('NOT rescheduled'),
        ),
    ).toBe(true);
    // Read once, then gone — a stale report must not be logged every boot.
    expect(fs.existsSync(file)).toBe(false);
    expect(reportInterruptedRuns()).toEqual([]);
  });

  it('survives a corrupt report file', () => {
    fs.mkdirSync(path.join(scratch, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'cache', 'drain-interrupted.json'),
      '{not json',
    );
    expect(reportInterruptedRuns()).toEqual([]);
  });
});
