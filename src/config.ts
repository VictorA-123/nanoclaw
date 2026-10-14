import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '3600000', // 1 hour — enough for scraper runs and multi-step code changes
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// --- Drain on shutdown (FABLE follow-up (g), see docs/DRAIN_PLAN.md) ---------
// On SIGTERM we refuse new work and wait a BOUNDED time for active runs to
// finish before stopping. The bound is the only tunable knob.
//
// The systemd unit's TimeoutStopSec must be this plus headroom, or systemd
// SIGKILLs us mid-drain and the whole mechanism is pointless. setup/service.ts
// derives it from DEFAULT_DRAIN_TIMEOUT_MS — if you change the default here,
// the generated unit follows, but an ALREADY-INSTALLED unit does not. Change
// both.
export const DEFAULT_DRAIN_TIMEOUT_MS = 300_000;
export const DRAIN_TIMEOUT_MS = Math.max(
  0,
  parseInt(
    process.env.NANOCLAW_DRAIN_TIMEOUT_MS || String(DEFAULT_DRAIN_TIMEOUT_MS),
    10,
  ) || DEFAULT_DRAIN_TIMEOUT_MS,
);
// After the bound we stop the containers, then give their awaiting callers a
// moment to run their own bookkeeping — the message-cursor rollback in
// processGroupMessages, and updateTaskAfterRun for a scheduled task. Not
// configurable: it is a settle window, not a policy.
export const DRAIN_SETTLE_MS = 10_000;
// How often the drain re-checks whether every run has finished.
export const DRAIN_POLL_MS = 250;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
