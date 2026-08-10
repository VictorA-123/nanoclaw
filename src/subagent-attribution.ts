/**
 * Subagent attribution poller (Phase 5, half 2).
 *
 * When Haddock consults Sketch via the Claude Code Task tool, the exchange
 * happens entirely inside Haddock's own container and is invisible to the
 * kernel — usage lands on agent:haddock, and there is no readable "what did
 * Haddock ask Sketch" record anywhere. This poller closes that gap WITHOUT
 * touching the container/agent-runner path at all: Claude Code's SDK already
 * writes a small, self-contained transcript for every subagent consultation
 * to the group's host-mounted .claude/projects/.../subagents/ directory
 * (agent-<id>.meta.json + agent-<id>.jsonl). This file just reads those,
 * once they're complete, and reports them to the kernel as a child run
 * nested under the consulting agent's own open run.
 *
 * Attribution here is completion-based, not live — the child run appears
 * once the consultation has finished, not while it's in progress. That is
 * an accepted limitation for one subagent (per the Phase 5 plan).
 *
 * Idempotency: the run id and every event's idempotency_key are deterministic
 * (derived from the subagent's own unique agentId), so a retried scan tick
 * can safely re-POST the same run/events without creating duplicates — the
 * kernel dedups on the PK / on UNIQUE(run_id, idempotency_key). The one
 * exception is the final usage_events POST, which has no dedup key at the
 * kernel today — it is therefore posted LAST, after the run and its events
 * are already durably recorded, and a subagent is only added to the
 * processed-set (preventing any future retry) once the usage POST itself
 * succeeds. The only residual risk is a crash in the narrow window between
 * a successful usage POST and the processed-set write to disk, which could
 * double-count one consultation's cost — rare, low-impact, correctable by
 * hand; not a structural gap.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';

const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';
const KERNEL_TIMEOUT_MS = 2500;

// group.folder -> { watcherAgentId: kernel id of the group doing the
// consulting, subagents: { agentType (from meta.json) -> kernel id to
// attribute that subagent's usage/runs to } }
const WATCHED_SUBAGENTS: Record<
  string,
  { watcherAgentId: string; subagents: Record<string, string> }
> = {
  whatsapp_builder: {
    watcherAgentId: 'agent:haddock',
    subagents: { sketch: 'agent:sketch' },
  },
};

const PROCESSED_FILE = path.join(
  process.cwd(),
  'cache',
  'processed-subagents.json',
);

function loadProcessed(): Set<string> {
  try {
    const raw = fs.readFileSync(PROCESSED_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveProcessed(processed: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(PROCESSED_FILE), { recursive: true });
    const tmp = PROCESSED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...processed], null, 2) + '\n');
    fs.renameSync(tmp, PROCESSED_FILE);
  } catch (err) {
    logger.warn({ err }, 'subagent-attribution: failed to persist processed set');
  }
}

async function kernelFetch(
  pathname: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; json: any } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KERNEL_TIMEOUT_MS);
  try {
    const res = await fetch(`${KERNEL_URL}${pathname}`, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // no/invalid body — fine for some responses
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    logger.warn({ pathname, err }, 'subagent-attribution: kernel fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
  }
  return '';
}

interface ParsedConsultation {
  agentId: string;
  mappedAgentId: string;
  watcherAgentId: string;
  prompt: string;
  response: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

function parseConsultation(
  metaPath: string,
  subagentMap: Record<string, string>,
  watcherAgentId: string,
): ParsedConsultation | null {
  const base = path.basename(metaPath, '.meta.json');
  const agentId = base.replace(/^agent-/, '');
  const jsonlPath = path.join(path.dirname(metaPath), `${base}.jsonl`);

  let meta: any;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  const mappedAgentId = subagentMap[meta?.agentType];
  if (!mappedAgentId) return null;

  if (!fs.existsSync(jsonlPath)) return null;

  const lines = fs
    .readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let firstEntry: any;
  try {
    firstEntry = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  let lastEntry: any;
  try {
    lastEntry = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }

  if (
    lastEntry?.type !== 'assistant' ||
    lastEntry?.message?.stop_reason !== 'end_turn'
  ) {
    return null;
  }

  const prompt = extractText(firstEntry?.message?.content);
  const response = extractText(lastEntry?.message?.content);
  const model = lastEntry?.message?.model ?? 'unknown';
  const usage = lastEntry?.message?.usage ?? {};
  const tokensIn =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const tokensOut = usage.output_tokens ?? 0;

  if (!prompt || !response) return null;

  return {
    agentId,
    mappedAgentId,
    watcherAgentId,
    prompt,
    response,
    model,
    tokensIn,
    tokensOut,
  };
}

function findSubagentMetaFiles(groupFolder: string): string[] {
  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  if (!fs.existsSync(projectsDir)) return [];

  const results: string[] = [];
  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of sessionDirs) {
    if (!entry.isDirectory()) continue;
    const subagentsDir = path.join(projectsDir, entry.name, 'subagents');
    if (!fs.existsSync(subagentsDir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(subagentsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.meta.json')) {
        results.push(path.join(subagentsDir, f));
      }
    }
  }
  return results;
}

async function reportConsultation(c: ParsedConsultation): Promise<boolean> {
  const openRuns = await kernelFetch(
    `/runs?agent_id=${encodeURIComponent(c.watcherAgentId)}&status=started`,
  );
  if (!openRuns?.ok || !Array.isArray(openRuns.json) || openRuns.json.length === 0) {
    logger.warn(
      { watcherAgentId: c.watcherAgentId },
      'subagent-attribution: no open run found for watcher, will retry next tick',
    );
    return false;
  }
  const parentRun = openRuns.json.reduce((a: any, b: any) =>
    a.started_at >= b.started_at ? a : b,
  );

  const childRunId = `run:subagent-${c.agentId}`;

  const existing = await kernelFetch(`/runs/${encodeURIComponent(childRunId)}`);
  if (!existing?.ok) {
    const created = await kernelFetch('/runs', {
      method: 'POST',
      body: {
        id: childRunId,
        agent_id: c.mappedAgentId,
        invoked_by: c.watcherAgentId,
        parent_run_id: parentRun.id,
        channel: 'internal',
        status: 'started',
      },
    });
    if (!created?.ok) {
      logger.warn(
        { childRunId, status: created?.status },
        'subagent-attribution: failed to create child run, will retry',
      );
      return false;
    }
  }

  const events: Array<{ type: string; content?: string; meta?: unknown }> = [
    { type: 'message_in', content: c.prompt },
    { type: 'message_out', content: c.response },
    { type: 'run_ended', meta: { source: 'subagent-attribution' } },
  ];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const res = await kernelFetch('/events', {
      method: 'POST',
      body: {
        run_id: childRunId,
        type: ev.type,
        content: ev.content,
        meta: ev.meta,
        idempotency_key: `${childRunId}:${ev.type}:${i + 1}`,
      },
    });
    if (!res || (!res.ok && res.status !== 409)) {
      logger.warn(
        { childRunId, type: ev.type, status: res?.status },
        'subagent-attribution: failed to post event, will retry',
      );
      return false;
    }
  }

  const usagePosted = await kernelFetch('/usage-events', {
    method: 'POST',
    body: {
      agent_id: c.mappedAgentId,
      run_id: childRunId,
      model: c.model,
      tokens_in: c.tokensIn,
      tokens_out: c.tokensOut,
    },
  });
  if (!usagePosted?.ok) {
    logger.warn(
      { childRunId, status: usagePosted?.status },
      'subagent-attribution: failed to post usage event, will retry',
    );
    return false;
  }

  logger.info(
    { childRunId, agent: c.mappedAgentId, parentRun: parentRun.id },
    'subagent-attribution: recorded consultation as child run',
  );
  return true;
}

export function startSubagentAttributionPoller(): void {
  const processed = loadProcessed();

  const tick = async () => {
    try {
      for (const [groupFolder, cfg] of Object.entries(WATCHED_SUBAGENTS)) {
        const metaFiles = findSubagentMetaFiles(groupFolder);
        for (const metaPath of metaFiles) {
          const base = path.basename(metaPath, '.meta.json');
          const agentId = base.replace(/^agent-/, '');
          if (processed.has(agentId)) continue;

          const consultation = parseConsultation(
            metaPath,
            cfg.subagents,
            cfg.watcherAgentId,
          );
          if (!consultation) continue;

          const ok = await reportConsultation(consultation);
          if (ok) {
            processed.add(consultation.agentId);
            saveProcessed(processed);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'subagent-attribution: scan tick failed');
    } finally {
      setTimeout(tick, IPC_POLL_INTERVAL);
    }
  };

  tick();
}
