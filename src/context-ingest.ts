/**
 * Context ingest — Phase 6 close-out (FABLE ruling 2026-10-06, P1-3 / P1-4).
 *
 * THE DIRECTION MATTERS. In this era the FILE is the source of truth and the
 * kernel is a faithful mirror of it. NanoClaw reads the agent's real context
 * file at spawn and, when its bytes differ from the kernel's latest context
 * version, posts a NEW durable version holding the real content. Nothing here
 * ever writes to a context file — materialization (kernel -> file) is Phase 8,
 * and doing both at once is the "two writers" failure the ruling exists to
 * prevent.
 *
 * Everything in this module is best-effort and OFF the critical path:
 *   - a kernel outage never blocks or fails a spawn (rule 6);
 *   - a failed ingest is logged and simply retried at the next spawn, because
 *     the trigger is "file hash != kernel hash", which stays true until it
 *     lands;
 *   - an unchanged file produces NO new version (idempotent).
 *
 * Old v1/v2 rows that hold a file PATH rather than content are left untouched
 * (P1-5). Their hash will not match the file, so the first ingest for each
 * agent posts exactly one cutover version carrying the real bytes; every
 * later spawn with an unchanged file is a no-op.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';
const INGEST_TIMEOUT_MS = 2500;

// Required by POST /agents/:id/context-versions (audit_log rule). Identifies
// the writer as this automated path, distinct from `victor:ssh` or a dashboard.
const INGEST_ACTOR = 'nanoclaw:ingest';

// P1-3 says durable, and P1-5 forbids repurposing `class` to mark the ingest
// cutover — `class` means pruning eligibility and nothing else. The legacy /
// ingest boundary is a created_at cutoff recorded in the spec, not a class.
const INGEST_CLASS = 'durable';

// A context file is prose. Anything larger than this is a mistargeted path
// (a log, a database, a binary), so skip rather than push it into kernel.db.
const MAX_CONTEXT_BYTES = 1024 * 1024;

export type IngestOutcome =
  | 'posted' // a new version was written to the kernel
  | 'unchanged' // file matches the kernel's latest version — nothing to do
  | 'no-targets' // agent has no context_targets — legacy behavior, not our business
  | 'unreadable' // primary target missing/unreadable/too large
  | 'failed'; // kernel rejected or was unreachable; retried next spawn

/**
 * Pull the ordered `context_targets` array out of an agent definition's
 * `nanoclaw_group` runtime config. Sibling of extractGroupFolder()/extractModel()
 * in container-runner.ts: same runtime_type filter, different key.
 *
 * Returns [] when the key is absent, not an array, or the config is malformed
 * (bad JSON is swallowed) — never throws. [] means "not configured", which the
 * caller treats as "fall back to current behavior unchanged".
 */
export function extractContextTargets(definition: unknown): string[] {
  const runtimes = Array.isArray((definition as any)?.runtimes)
    ? (definition as any).runtimes
    : [];
  for (const rt of runtimes) {
    if (rt?.runtime_type !== 'nanoclaw_group') continue;
    try {
      const cfg = JSON.parse(rt?.config ?? '{}');
      if (!Array.isArray(cfg?.context_targets)) continue;
      const targets = cfg.context_targets.filter(
        (t: unknown): t is string => typeof t === 'string' && t.length > 0,
      );
      if (targets.length > 0) return targets;
    } catch {
      // malformed runtime config — treat as no targets
    }
  }
  return [];
}

/** The content of the definition's latest context version, or null if none. */
export function extractLatestContextContent(
  definition: unknown,
): string | null {
  const c = (definition as any)?.context_version?.content;
  return typeof c === 'string' ? c : null;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * A target must resolve INSIDE the NanoClaw project root. The registry is
 * Victor-only, so this is not a trust boundary against an attacker — it is a
 * blast-radius limit on a typo or a stale row: without it, a `context_targets`
 * entry of `.env` or `/etc/shadow` would push that file's bytes into kernel.db
 * as durable, backed-up history. Same `path.relative` shape as
 * group-folder.ts's ensureWithinBase.
 */
function isWithinProjectRoot(abs: string, projectRoot: string): boolean {
  const rel = path.relative(path.resolve(projectRoot), abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Read one target's real bytes. Targets are recorded relative to the NanoClaw
 * project root (e.g. `groups/sketch/dashboard-context.md`); an absolute path is
 * accepted only if it also lands inside the project root. Returns null on any
 * problem — outside the root, missing, a directory, oversize.
 */
function readTarget(
  target: string,
  projectRoot: string,
): { abs: string; bytes: Buffer } | null {
  const abs = path.resolve(projectRoot, target);
  if (!isWithinProjectRoot(abs, projectRoot)) {
    logger.warn(
      { target: abs, projectRoot },
      'context-ingest: target resolves outside the project root — refusing to read',
    );
    return null;
  }
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_CONTEXT_BYTES) {
      logger.warn(
        { target: abs, size: st.size, max: MAX_CONTEXT_BYTES },
        'context-ingest: target exceeds size limit — skipping',
      );
      return null;
    }
    return { abs, bytes: fs.readFileSync(abs) };
  } catch (err) {
    logger.warn({ target: abs, err }, 'context-ingest: target unreadable');
    return null;
  }
}

/**
 * Compare every configured target against the PRIMARY (first in the list) and
 * log one WARN naming both paths for each copy that disagrees. Read-only: the
 * ruling is explicit that in the ingest era we NEVER write to a target file.
 * Secondary copies converge in Phase 8, when materialization writes them all.
 */
function warnOnTargetDrift(
  agentId: string,
  targets: string[],
  projectRoot: string,
  primaryAbs: string,
  primaryHash: string,
): void {
  for (const target of targets.slice(1)) {
    const read = readTarget(target, projectRoot);
    if (!read) {
      logger.warn(
        {
          agentId,
          primary: primaryAbs,
          secondary: path.resolve(projectRoot, target),
        },
        `context-ingest: DRIFT — secondary target unreadable (primary: ${primaryAbs}, secondary: ${path.resolve(projectRoot, target)})`,
      );
      continue;
    }
    const hash = sha256(read.bytes);
    if (hash !== primaryHash) {
      logger.warn(
        {
          agentId,
          primary: primaryAbs,
          primaryHash,
          secondary: read.abs,
          secondaryHash: hash,
        },
        `context-ingest: DRIFT — copies differ (primary: ${primaryAbs}, secondary: ${read.abs}). Not writing to either; materialization is Phase 8.`,
      );
    }
  }
}

/**
 * Ingest one agent's context file into the kernel, if it has changed.
 *
 * `latestContent` is the kernel's current latest version content, which the
 * caller already has in hand from GET /agents/:id/definition — no extra fetch.
 * Pass it only when it came from the KERNEL: comparing against a stale cached
 * definition would post a redundant version.
 *
 * Never throws. Returns what happened, for tests and for the caller's log.
 */
export async function ingestContextVersion(
  agentId: string,
  opts: {
    targets: string[];
    latestContent: string | null;
    projectRoot?: string;
  },
): Promise<IngestOutcome> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  try {
    if (opts.targets.length === 0) return 'no-targets';

    // PRIMARY is the first target. It alone decides what gets ingested.
    const primary = readTarget(opts.targets[0], projectRoot);
    if (!primary) {
      logger.warn(
        { agentId, target: path.resolve(projectRoot, opts.targets[0]) },
        'context-ingest: primary target unreadable — skipping ingest this spawn',
      );
      return 'unreadable';
    }
    const fileHash = sha256(primary.bytes);

    if (opts.targets.length > 1) {
      warnOnTargetDrift(
        agentId,
        opts.targets,
        projectRoot,
        primary.abs,
        fileHash,
      );
    }

    // The kernel's mirror is current when its latest version's bytes hash to
    // the same value. A null latestContent means the agent has no version yet,
    // which always ingests.
    const kernelHash =
      opts.latestContent == null ? null : sha256(opts.latestContent);
    if (kernelHash === fileHash) {
      logger.debug(
        { agentId, target: primary.abs, hash: fileHash },
        'context-ingest: file matches kernel latest — no new version',
      );
      return 'unchanged';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `${KERNEL_URL}/agents/${encodeURIComponent(agentId)}/context-versions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: INGEST_ACTOR,
            class: INGEST_CLASS,
            content: primary.bytes.toString('utf8'),
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      logger.warn(
        { agentId, target: primary.abs, status: res.status },
        'context-ingest: kernel rejected the new version — retrying next spawn',
      );
      return 'failed';
    }

    const row = (await res.json().catch(() => null)) as {
      id?: string;
      version?: number;
    } | null;
    logger.info(
      {
        agentId,
        target: primary.abs,
        hash: fileHash,
        kernelHash,
        contextVersionId: row?.id ?? null,
        version: row?.version ?? null,
        bytes: primary.bytes.length,
      },
      `context-ingest: posted context version ${row?.version ?? '?'} for ${agentId} from ${primary.abs}`,
    );
    return 'posted';
  } catch (err) {
    // Includes kernel unreachable / timeout. Logged, never rethrown: the spawn
    // that called us must not notice, and the next spawn retries.
    logger.warn(
      { agentId, err },
      'context-ingest: failed — retrying next spawn',
    );
    return 'failed';
  }
}
