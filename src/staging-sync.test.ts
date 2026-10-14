/**
 * Phase 6 close-out, P1-6: agent-runner staging is sync-if-stale by content
 * hash. These run entirely under a fresh os.tmpdir() scratch tree — no live
 * data/sessions/ directory and no containers are touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncStagedAgentRunner } from './container-runner.js';

let root: string;
let src: string;
let dst: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-staging-'));
  src = path.join(root, 'src');
  dst = path.join(root, 'staged');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('syncStagedAgentRunner', () => {
  it('copies everything into an empty staging dir', () => {
    fs.writeFileSync(path.join(src, 'index.ts'), 'v1');
    fs.mkdirSync(path.join(src, 'nested'));
    fs.writeFileSync(path.join(src, 'nested', 'tool.ts'), 'tool');

    const synced = syncStagedAgentRunner(src, dst).sort();

    expect(synced).toEqual(['index.ts', path.join('nested', 'tool.ts')]);
    expect(fs.readFileSync(path.join(dst, 'index.ts'), 'utf8')).toBe('v1');
    expect(fs.readFileSync(path.join(dst, 'nested', 'tool.ts'), 'utf8')).toBe(
      'tool',
    );
  });

  it('is a no-op when the bytes already match (idempotent)', () => {
    fs.writeFileSync(path.join(src, 'index.ts'), 'v1');
    expect(syncStagedAgentRunner(src, dst)).toEqual(['index.ts']);
    expect(syncStagedAgentRunner(src, dst)).toEqual([]);
  });

  it('refreshes a stale staged file — the copy-once bug this fixes', () => {
    fs.writeFileSync(path.join(src, 'index.ts'), 'v1');
    syncStagedAgentRunner(src, dst);

    // Upstream agent-runner changes after the group was first staged.
    fs.writeFileSync(path.join(src, 'index.ts'), 'v2');

    expect(syncStagedAgentRunner(src, dst)).toEqual(['index.ts']);
    expect(fs.readFileSync(path.join(dst, 'index.ts'), 'utf8')).toBe('v2');
  });

  it('ignores mtime — identical bytes with a newer mtime do not resync', () => {
    fs.writeFileSync(path.join(src, 'index.ts'), 'v1');
    syncStagedAgentRunner(src, dst);

    // Same content, source touched far into the future.
    const future = new Date(Date.now() + 86_400_000);
    fs.utimesSync(path.join(src, 'index.ts'), future, future);

    expect(syncStagedAgentRunner(src, dst)).toEqual([]);
  });

  it('never deletes files that exist only in the group staging dir', () => {
    fs.writeFileSync(path.join(src, 'index.ts'), 'v1');
    fs.writeFileSync(path.join(dst, 'agent-custom.ts'), 'mine');
    fs.mkdirSync(path.join(dst, 'dist'));
    fs.writeFileSync(path.join(dst, 'dist', 'index.js'), 'built');

    syncStagedAgentRunner(src, dst);

    expect(fs.readFileSync(path.join(dst, 'agent-custom.ts'), 'utf8')).toBe(
      'mine',
    );
    expect(fs.readFileSync(path.join(dst, 'dist', 'index.js'), 'utf8')).toBe(
      'built',
    );
  });
});
