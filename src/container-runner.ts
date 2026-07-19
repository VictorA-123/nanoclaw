/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import {
  deregisterContainer,
  detectAuthMode,
  registerContainer,
} from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Resolve a container's bridge IP via `docker inspect`. Docker assigns the IP
 * during container start, so the inspect call may briefly race the spawn —
 * retry a few times before giving up. Returns null if the IP can't be found;
 * callers should treat that as a soft failure (token usage will be recorded
 * with agent=null until the container next spawns and re-registers).
 */
async function inspectContainerIp(
  containerName: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const ip = await new Promise<string>((resolve, reject) => {
        exec(
          // Default-bridge containers expose the IP under
          // .NetworkSettings.Networks.bridge.IPAddress.
          // The top-level .NetworkSettings.IPAddress is only populated
          // for the legacy unnamed network and stays empty for these.
          `docker inspect --format '{{.NetworkSettings.Networks.bridge.IPAddress}}' ${containerName}`,
          { timeout: 5000 },
          (err, stdout) => {
            if (err) return reject(err);
            resolve((stdout || '').trim());
          },
        );
      });
      if (ip.length > 0) return ip;
    } catch {
      // ignore; retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// --- Phase 3 pillar 1: definition-fetch — REAL (kernel-primary, cache fallback) ---
// Explicit group.folder -> kernel agent-id map. Only mapped groups are driven by
// the kernel definition; unmapped groups always use the legacy-local path.
const AGENT_IDS: Record<string, string> = {
  whatsapp_main: 'agent:jammer',
  whatsapp_builder: 'agent:haddock',
};
const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';
const DEFINITION_CACHE_DIR = path.join(process.cwd(), 'cache', 'definitions');
const DEFINITION_FETCH_TIMEOUT_MS = 2500;

type SpawnSource = 'kernel' | 'cache-fallback' | 'legacy-local';

interface ResolvedDefinition {
  source: SpawnSource;
  // Absolute path to mount as /workspace/group (the context-bearing folder).
  groupFolderPath: string;
  // Kernel/cache-recorded context path, for the registry-vs-reality log (null for legacy).
  contextPath: string | null;
}

// Extract the nanoclaw_group runtime's absolute group_folder from a definition.
// Returns null if absent/malformed (bad JSON is swallowed).
function extractGroupFolder(definition: any): string | null {
  const runtimes = Array.isArray(definition?.runtimes) ? definition.runtimes : [];
  for (const rt of runtimes) {
    if (rt?.runtime_type !== 'nanoclaw_group') continue;
    try {
      const cfg = JSON.parse(rt?.config ?? '{}');
      if (typeof cfg?.group_folder === 'string' && cfg.group_folder.length > 0) {
        return cfg.group_folder;
      }
    } catch {
      // malformed runtime config — treat as no folder
    }
  }
  return null;
}

function extractContextPath(definition: any): string | null {
  const c = definition?.context_version?.content;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

// A definition is only usable to drive a spawn if it names a group folder that
// actually exists as a directory on this host.
function usableGroupDir(folder: string | null): folder is string {
  if (!folder) return false;
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve which definition drives this spawn, kernel-primary with a strict
 * three-tier fallback that ALWAYS ends in a usable group folder:
 *   1. kernel  — GET /agents/<id>/definition (hard ~2.5s timeout). On success
 *      with a usable group_folder, drive from it AND refresh the cache.
 *   2. cache-fallback — the last-known-good cache/definitions/<id>.json, if it
 *      parses and names a usable group_folder.
 *   3. legacy-local — resolveGroupFolderPath(group.folder), i.e. exactly today's
 *      behavior. Unmapped groups and every failure land here.
 * This function never throws; the caller also guards it. The kernel-vs-local
 * comparison is logged by the caller from the returned contextPath.
 */
async function resolveSpawnDefinition(
  group: RegisteredGroup,
): Promise<ResolvedDefinition> {
  const legacyFolder = resolveGroupFolderPath(group.folder);
  const agentId = AGENT_IDS[group.folder];

  // Unmapped groups have no kernel identity — behave exactly as today.
  if (!agentId) {
    return {
      source: 'legacy-local',
      groupFolderPath: legacyFolder,
      contextPath: null,
    };
  }

  // Tier 1: kernel (bounded by a hard timeout so a slow/hung kernel can't stall).
  let kernelDef: any = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFINITION_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${KERNEL_URL}/agents/${agentId}/definition`, {
        signal: controller.signal,
      });
      if (res.ok) {
        kernelDef = await res.json();
      } else {
        logger.warn(
          { agentId, status: res.status },
          'definition-fetch: kernel returned non-OK — trying cache',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn(
      { agentId, err },
      'definition-fetch: kernel unreachable/timeout — trying cache',
    );
  }

  if (kernelDef) {
    const folder = extractGroupFolder(kernelDef);
    if (usableGroupDir(folder)) {
      // Refresh last-known-good cache (best-effort; failure never blocks spawn).
      try {
        fs.mkdirSync(DEFINITION_CACHE_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(DEFINITION_CACHE_DIR, `${agentId}.json`),
          JSON.stringify(kernelDef, null, 2) + '\n',
        );
      } catch (err) {
        logger.warn(
          { agentId, err },
          'definition-fetch: cache refresh failed (continuing spawn from kernel)',
        );
      }
      return {
        source: 'kernel',
        groupFolderPath: folder,
        contextPath: extractContextPath(kernelDef),
      };
    }
    logger.warn(
      { agentId },
      'definition-fetch: kernel definition unusable (no valid group_folder) — trying cache',
    );
  }

  // Tier 2: cached last-known-good.
  try {
    const cached = JSON.parse(
      fs.readFileSync(
        path.join(DEFINITION_CACHE_DIR, `${agentId}.json`),
        'utf8',
      ),
    );
    const folder = extractGroupFolder(cached);
    if (usableGroupDir(folder)) {
      return {
        source: 'cache-fallback',
        groupFolderPath: folder,
        contextPath: extractContextPath(cached),
      };
    }
    logger.warn(
      { agentId },
      'definition-fetch: cached definition unusable — using legacy-local',
    );
  } catch (err) {
    logger.warn(
      { agentId, err },
      'definition-fetch: no usable cache — using legacy-local',
    );
  }

  // Tier 3: legacy-local — never worse than today; folder is created by the caller.
  return {
    source: 'legacy-local',
    groupFolderPath: legacyFolder,
    contextPath: null,
  };
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  groupDir: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  // groupDir (the /workspace/group source) is resolved by the caller from the
  // effective definition (kernel/cache) or the legacy path. Sessions, IPC, and
  // agent-runner mounts below stay keyed on the stable group.folder.

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  // World-writable so the container's node user can create subdirs (e.g. session-env)
  fs.chmodSync(groupSessionsDir, 0o777);
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  // Container runs as non-root (node user) — all IPC subdirs need to be world-writable
  for (const subdir of ['messages', 'tasks', 'input']) {
    const dir = path.join(groupIpcDir, subdir);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  if (fs.existsSync(groupAgentRunnerDir)) {
    // World-writable so the container can recompile agent-runner on startup
    fs.chmodSync(groupAgentRunnerDir, 0o777);
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  // Phase 3 pillar 1 (REAL): the spawn's group folder / context is now sourced
  // from the kernel definition (kernel-primary), with cache and legacy-local
  // fallback. Outer guard: any unexpected failure in resolution falls back to
  // the legacy path so a spawn can NEVER hard-fail because of definition-fetch.
  let resolved: ResolvedDefinition;
  try {
    resolved = await resolveSpawnDefinition(group);
  } catch (err) {
    logger.warn(
      { group: group.folder, err },
      'definition-fetch: resolver threw — falling back to legacy-local',
    );
    resolved = {
      source: 'legacy-local',
      groupFolderPath: resolveGroupFolderPath(group.folder),
      contextPath: null,
    };
  }

  const groupDir = resolved.groupFolderPath;
  fs.mkdirSync(groupDir, { recursive: true });
  // Container runs as node user (uid 1000); host may be root. Ensure the
  // group workspace is world-writable so the container can write files.
  fs.chmodSync(groupDir, 0o777);

  // Log which tier drove this spawn, plus the registry-vs-reality comparison
  // (kernel-recorded context path vs. the dashboard-context.md we mount).
  const localContext = path.join(groupDir, 'dashboard-context.md');
  logger.info(
    {
      group: group.name,
      agentId: AGENT_IDS[group.folder] ?? null,
      spawnSource: resolved.source,
      kernel: resolved.contextPath,
      local: localContext,
      match: resolved.contextPath === localContext,
    },
    `Definition-driven spawn — source: ${resolved.source} / kernel: ${resolved.contextPath} / local: ${localContext} / match: ${resolved.contextPath === localContext}`,
  );

  const mounts = buildVolumeMounts(group, input.isMain, groupDir);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    // Register the container's bridge IP with the credential proxy so it can
    // attribute Anthropic API calls to the right agent. The inspect runs
    // async; until it completes the first call or two may post with
    // agent=null. The VAN endpoint keeps those records intentionally.
    let registeredIp: string | null = null;
    const agentNameForProxy = input.assistantName || group.name;
    inspectContainerIp(containerName)
      .then((ip) => {
        if (ip) {
          registerContainer(ip, agentNameForProxy);
          registeredIp = ip;
        }
      })
      .catch((err) => {
        logger.warn(
          { err, containerName },
          'Container IP inspect failed — token attribution will be null',
        );
      });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      if (registeredIp) {
        deregisterContainer(registeredIp);
        registeredIp = null;
      }
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      if (registeredIp) {
        deregisterContainer(registeredIp);
        registeredIp = null;
      }
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
