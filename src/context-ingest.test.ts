/**
 * Phase 6 close-out, P1-3 / P1-4: context ingest.
 *
 * Real files under a fresh os.tmpdir() scratch tree; `fetch` is stubbed, so no
 * request ever reaches the live kernel and no live file is read or written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  extractContextTargets,
  extractLatestContextContent,
  ingestContextVersion,
} from './context-ingest.js';
import { logger } from './logger.js';

let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

function def(config: unknown, contextContent?: string): unknown {
  return {
    runtimes: [
      { runtime_type: 'claude_code_subagent', config: '{"x":1}' },
      { runtime_type: 'nanoclaw_group', config: JSON.stringify(config) },
    ],
    context_version:
      contextContent === undefined ? null : { content: contextContent },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ingest-'));
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ id: 'ctx:test', version: 3 }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('extractContextTargets', () => {
  it('reads the ordered array from the nanoclaw_group runtime', () => {
    expect(
      extractContextTargets(def({ context_targets: ['a.md', 'b.md'] })),
    ).toEqual(['a.md', 'b.md']);
  });

  it('returns [] when absent, malformed, or the wrong shape', () => {
    expect(extractContextTargets(def({ group_folder: '/x' }))).toEqual([]);
    expect(extractContextTargets(def({ context_targets: 'a.md' }))).toEqual([]);
    expect(
      extractContextTargets({
        runtimes: [{ runtime_type: 'nanoclaw_group', config: '{oops' }],
      }),
    ).toEqual([]);
    expect(extractContextTargets(null)).toEqual([]);
  });
});

describe('extractLatestContextContent', () => {
  it('returns the content string, or null when there is no version', () => {
    expect(extractLatestContextContent(def({}, 'hello'))).toBe('hello');
    expect(extractLatestContextContent(def({}))).toBeNull();
  });
});

describe('ingestContextVersion', () => {
  it('does nothing when no targets are configured', async () => {
    const out = await ingestContextVersion('agent:x', {
      targets: [],
      latestContent: 'anything',
      projectRoot: root,
    });
    expect(out).toBe('no-targets');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the real file content with the ingest actor and durable class', async () => {
    fs.writeFileSync(path.join(root, 'ctx.md'), '# real content\n');

    const out = await ingestContextVersion('agent:sketch', {
      targets: ['ctx.md'],
      // What the backfill left behind: a PATH, not content.
      latestContent: '/root/nanoclaw/groups/sketch/dashboard-context.md',
      projectRoot: root,
    });

    expect(out).toBe('posted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/agents/agent%3Asketch/context-versions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      actor: 'nanoclaw:ingest',
      class: 'durable',
      content: '# real content\n',
    });
  });

  it('posts when the agent has no context version at all', async () => {
    fs.writeFileSync(path.join(root, 'ctx.md'), 'first');
    const out = await ingestContextVersion('agent:x', {
      targets: ['ctx.md'],
      latestContent: null,
      projectRoot: root,
    });
    expect(out).toBe('posted');
  });

  it('is idempotent — an unchanged file produces no new version', async () => {
    fs.writeFileSync(path.join(root, 'ctx.md'), 'same bytes\n');
    const out = await ingestContextVersion('agent:x', {
      targets: ['ctx.md'],
      latestContent: 'same bytes\n',
      projectRoot: root,
    });
    expect(out).toBe('unchanged');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('WARNs naming both paths when two copies differ, and writes no file', async () => {
    const primary = path.join(root, 'primary.md');
    const secondary = path.join(root, 'secondary.md');
    fs.writeFileSync(primary, 'A');
    fs.writeFileSync(secondary, 'B');

    const out = await ingestContextVersion('agent:sketch', {
      targets: ['primary.md', 'secondary.md'],
      latestContent: null,
      projectRoot: root,
    });

    expect(out).toBe('posted');
    const drift = vi
      .mocked(logger.warn)
      .mock.calls.find((c) => String(c[1]).includes('DRIFT'));
    expect(drift).toBeDefined();
    expect(String(drift?.[1])).toContain(primary);
    expect(String(drift?.[1])).toContain(secondary);

    // The file is the source of truth — ingest never writes to a target.
    expect(fs.readFileSync(primary, 'utf8')).toBe('A');
    expect(fs.readFileSync(secondary, 'utf8')).toBe('B');
    // Only the PRIMARY is ingested.
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.content).toBe('A');
  });

  it('does not WARN drift when the two copies match', async () => {
    fs.writeFileSync(path.join(root, 'primary.md'), 'same');
    fs.writeFileSync(path.join(root, 'secondary.md'), 'same');
    await ingestContextVersion('agent:sketch', {
      targets: ['primary.md', 'secondary.md'],
      latestContent: 'same',
      projectRoot: root,
    });
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.filter((c) => String(c[1]).includes('DRIFT')),
    ).toHaveLength(0);
  });

  it('skips cleanly when the primary target is missing', async () => {
    const out = await ingestContextVersion('agent:x', {
      targets: ['nope.md'],
      latestContent: null,
      projectRoot: root,
    });
    expect(out).toBe('unreadable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the kernel is unreachable — retried next spawn', async () => {
    fs.writeFileSync(path.join(root, 'ctx.md'), 'x');
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      ingestContextVersion('agent:x', {
        targets: ['ctx.md'],
        latestContent: null,
        projectRoot: root,
      }),
    ).resolves.toBe('failed');
  });

  it('never throws when the kernel rejects the post', async () => {
    fs.writeFileSync(path.join(root, 'ctx.md'), 'x');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'class is required' }),
    });
    await expect(
      ingestContextVersion('agent:x', {
        targets: ['ctx.md'],
        latestContent: null,
        projectRoot: root,
      }),
    ).resolves.toBe('failed');
  });
});
