import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/**
 * Ask a running container to wind down, by dropping the `_close` sentinel the
 * agent-runner watches for. The container finishes what it is doing and exits
 * instead of sitting in its IPC wait until IDLE_TIMEOUT (30 minutes).
 *
 * Shared by GroupQueue.closeStdin() and the shutdown drain. The drain cannot go
 * through the queue: invocation-poller spawns never set the queue's `active`
 * flag, so closeStdin() would silently return for exactly the runs the drain
 * most needs to wind down.
 *
 * Returns false instead of throwing — a container that cannot be asked nicely
 * is stopped at the bound anyway.
 */
export function writeCloseSentinel(folder: string): boolean {
  try {
    const inputDir = path.join(resolveGroupIpcPath(folder), 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
    return true;
  } catch {
    return false;
  }
}
