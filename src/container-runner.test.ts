import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      // mkdirSync is mocked away, so the group dir never actually exists and
      // the real chmodSync threw ENOENT, failing all three timeout tests.
      chmodSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

// Kernel event emission is reporting-only; stub it so nothing reaches :4100.
vi.mock('./kernel-events.js', () => ({
  emitRunStarted: vi.fn(async () => 'run:test'),
  emitEvent: vi.fn(async () => {}),
}));

import {
  runContainerAgent,
  ContainerOutput,
  listActiveRuns,
  markClosedByDrain,
  _resetActiveRunsForTests,
} from './container-runner.js';
import { emitEvent } from './kernel-events.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

// Drain, follow-up (g). The registry lives in runContainerAgent() because that
// is the only place EVERY spawn path goes through — GroupQueue.activeCount
// misses invocation-poller spawns entirely.
describe('active-run registry', () => {
  const mappedGroup: RegisteredGroup = {
    name: 'Jammer',
    folder: 'whatsapp_main',
    trigger: '',
    added_at: new Date().toISOString(),
    isMain: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    _resetActiveRunsForTests();
    vi.mocked(emitEvent).mockClear();
    // Keep definition-fetch off the network: it falls through to legacy-local.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no kernel in tests');
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers a run while it is live and clears it on close', async () => {
    const p = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const live = listActiveRuns();
    expect(live).toHaveLength(1);
    expect(live[0].group.folder).toBe('test-group');
    expect(live[0].chatJid).toBe('test@g.us');
    expect(live[0].closedByDrain).toBe(false);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(listActiveRuns()).toEqual([]);
  });

  it('carries the scheduled-task id so a drain report can name it', async () => {
    const p = runContainerAgent(
      testGroup,
      { ...testInput, isScheduledTask: true, taskId: 'task-7' },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(listActiveRuns()[0]).toMatchObject({
      isScheduledTask: true,
      taskId: 'task-7',
    });

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await p;
  });

  it('emits run_ended normally when the run closes on its own', async () => {
    const p = runContainerAgent(mappedGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(
      vi.mocked(emitEvent).mock.calls.filter((c) => c[1] === 'run_ended'),
    ).toHaveLength(1);
  });

  it('suppresses its own run_ended once the drain has closed the run', async () => {
    const p = runContainerAgent(mappedGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const [run] = listActiveRuns();
    expect(markClosedByDrain(run.containerName)).toBe(true);

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // The drain emitted the drain-timeout run_ended itself; a second one here
    // would make the transcript show the run ending twice.
    expect(
      vi.mocked(emitEvent).mock.calls.filter((c) => c[1] === 'run_ended'),
    ).toHaveLength(0);
  });

  it('markClosedByDrain reports false for a run that already finished', async () => {
    const p = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    const [run] = listActiveRuns();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(markClosedByDrain(run.containerName)).toBe(false);
  });
});
