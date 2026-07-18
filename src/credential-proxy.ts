/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Token usage capture (Phase 3):
 *   For POST /v1/messages with 2xx responses, the proxy tees the response —
 *   one stream pipes to the container unchanged (no latency), the other is
 *   parsed for `usage` data. On stream end the proxy fires a fire-and-forget
 *   POST to the VAN dashboard. Failures are logged and silently dropped;
 *   the proxied response is never affected.
 *
 *   Per-agent attribution comes from a shared Map<containerIp, agentName>
 *   that container-runner.ts populates after `docker inspect` returns the
 *   container's bridge IP. Module-level state, in-memory only — on NanoClaw
 *   restart, containers re-register when they next spawn.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// ─── Container → agent registration ─────────────────────────────────────────

const ipToAgent = new Map<string, string>();

function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  // Node represents IPv4 over a dual-stack socket as ::ffff:1.2.3.4
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

export function registerContainer(ip: string, agentName: string): void {
  const norm = normalizeIp(ip);
  if (!norm) return;
  ipToAgent.set(norm, agentName);
  logger.info(
    { ip: norm, agent: agentName },
    'Container registered with credential proxy',
  );
}

export function deregisterContainer(ip: string): void {
  const norm = normalizeIp(ip);
  if (!norm) return;
  ipToAgent.delete(norm);
  logger.info({ ip: norm }, 'Container deregistered from credential proxy');
}

export function getAgentForIp(ip: string | undefined | null): string | null {
  const norm = normalizeIp(ip);
  if (!norm) return null;
  return ipToAgent.get(norm) ?? null;
}

// ─── Usage extraction ───────────────────────────────────────────────────────

const VAN_DASHBOARD_URL =
  process.env.VAN_DASHBOARD_URL || 'http://127.0.0.1:4000';
const VAN_TOKEN_USAGE_PATH = '/api/internal/token-usage';
const KERNEL_URL = process.env.KERNEL_URL || 'http://127.0.0.1:4100';
const KERNEL_USAGE_PATH = '/usage-events';
const MAX_BUFFERED_BODY = 1_000_000; // 1MB cap for non-streaming bodies

interface Usage {
  session_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

function newUsage(): Usage {
  return {
    session_id: null,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function hasUsage(u: Usage): boolean {
  return Boolean(
    u.session_id ||
    u.input_tokens ||
    u.output_tokens ||
    u.cache_creation_input_tokens ||
    u.cache_read_input_tokens,
  );
}

// SSE: each `data:` line is one event payload. Anthropic emits message_start
// once (carries session id + model + initial input usage), then many
// message_delta events (only the final one has the complete output_tokens),
// then message_stop. We accumulate and overwrite — latest values win.
function applySseEvent(u: Usage, data: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  const ev = parsed as {
    type?: string;
    message?: {
      id?: string;
      model?: string;
      usage?: Record<string, number>;
    };
    usage?: Record<string, number>;
  };
  if (ev.type === 'message_start' && ev.message) {
    if (typeof ev.message.id === 'string') u.session_id = ev.message.id;
    if (typeof ev.message.model === 'string') u.model = ev.message.model;
    const m = ev.message.usage;
    if (m && typeof m === 'object') {
      if (typeof m.input_tokens === 'number') u.input_tokens = m.input_tokens;
      if (typeof m.cache_creation_input_tokens === 'number')
        u.cache_creation_input_tokens = m.cache_creation_input_tokens;
      if (typeof m.cache_read_input_tokens === 'number')
        u.cache_read_input_tokens = m.cache_read_input_tokens;
    }
  } else if (ev.type === 'message_delta' && ev.usage) {
    const m = ev.usage;
    if (typeof m.output_tokens === 'number') u.output_tokens = m.output_tokens;
    if (typeof m.input_tokens === 'number') u.input_tokens = m.input_tokens;
    if (typeof m.cache_creation_input_tokens === 'number')
      u.cache_creation_input_tokens = m.cache_creation_input_tokens;
    if (typeof m.cache_read_input_tokens === 'number')
      u.cache_read_input_tokens = m.cache_read_input_tokens;
  }
}

function applyJsonBody(u: Usage, body: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  const r = parsed as {
    id?: string;
    model?: string;
    usage?: Record<string, number>;
  };
  if (typeof r.id === 'string') u.session_id = r.id;
  if (typeof r.model === 'string') u.model = r.model;
  const m = r.usage;
  if (m && typeof m === 'object') {
    if (typeof m.input_tokens === 'number') u.input_tokens = m.input_tokens;
    if (typeof m.output_tokens === 'number') u.output_tokens = m.output_tokens;
    if (typeof m.cache_creation_input_tokens === 'number')
      u.cache_creation_input_tokens = m.cache_creation_input_tokens;
    if (typeof m.cache_read_input_tokens === 'number')
      u.cache_read_input_tokens = m.cache_read_input_tokens;
  }
}

function postUsageToVan(u: Usage, agent: string | null): void {
  if (!hasUsage(u)) return;

  let url: URL;
  try {
    url = new URL(VAN_TOKEN_USAGE_PATH, VAN_DASHBOARD_URL);
  } catch (err) {
    logger.warn(
      { err },
      'Invalid VAN_DASHBOARD_URL — skipping token-usage POST',
    );
    return;
  }

  const body = JSON.stringify({
    agent,
    session_id: u.session_id,
    model: u.model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
  });

  const isHttps = url.protocol === 'https:';
  const fn = isHttps ? httpsRequest : httpRequest;
  const req = fn(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 3000,
    } as RequestOptions,
    (vanRes) => {
      vanRes.resume();
      if ((vanRes.statusCode ?? 0) >= 400) {
        logger.warn(
          { status: vanRes.statusCode, agent },
          'VAN dashboard rejected token-usage POST',
        );
      } else {
        logger.info(
          {
            status: vanRes.statusCode,
            agent,
            total:
              u.input_tokens +
              u.output_tokens +
              u.cache_creation_input_tokens +
              u.cache_read_input_tokens,
          },
          'Posted token usage to VAN',
        );
      }
    },
  );
  req.on('error', (err) => {
    logger.warn({ err, agent }, 'Failed to POST token usage to VAN dashboard');
  });
  req.on('timeout', () => req.destroy());
  req.write(body);
  req.end();
}

// Kernel cost meter (Phase 2). Independent, fire-and-forget sibling of the VAN
// POST above: same hasUsage() gate, same 3000ms timeout, its OWN try/catch. A
// kernel that is down, slow, or returns >=400 only logs a warning — it never
// throws, never blocks, and never affects the VAN POST or the agent response.
// Sends the same bare agent string as agent_id (the kernel resolves it); run_id
// is null (the proxy has no kernel run id); billing_source_id is omitted so the
// kernel defaults to the active source. Skips entirely when the IP->agent lookup
// missed (agent == null): unattributable usage is not metered.
function postUsageToKernel(u: Usage, agent: string | null): void {
  if (!hasUsage(u)) return;
  if (agent == null) return;

  try {
    let url: URL;
    try {
      url = new URL(KERNEL_USAGE_PATH, KERNEL_URL);
    } catch (err) {
      logger.warn(
        { err },
        'Invalid KERNEL_URL — skipping kernel usage-events POST',
      );
      return;
    }

    const body = JSON.stringify({
      agent_id: agent,
      model: u.model,
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      run_id: null,
    });

    const isHttps = url.protocol === 'https:';
    const fn = isHttps ? httpsRequest : httpRequest;
    const req = fn(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 3000,
      } as RequestOptions,
      (kernelRes) => {
        kernelRes.resume();
        if ((kernelRes.statusCode ?? 0) >= 400) {
          logger.warn(
            { status: kernelRes.statusCode, agent },
            'Kernel rejected usage-events POST',
          );
        } else {
          logger.info(
            { status: kernelRes.statusCode, agent, model: u.model },
            'Posted usage event to kernel',
          );
        }
      },
    );
    req.on('error', (err) => {
      logger.warn({ err, agent }, 'Failed to POST usage event to kernel');
    });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (err) {
    logger.warn({ err, agent }, 'Kernel usage-events POST failed to dispatch');
  }
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const isMessagesRequest =
          req.method === 'POST' && (req.url ?? '').startsWith('/v1/messages');
        const containerIp = req.socket?.remoteAddress;

        // For /v1/messages, force uncompressed responses so the SSE parser
        // can read the stream directly. Containers see uncompressed bytes
        // either way; cost is a small bandwidth increase per call.
        if (isMessagesRequest) {
          delete headers['accept-encoding'];
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);

            // Attach usage-capture listeners BEFORE pipe() puts the stream
            // into flowing mode, so we see every chunk. The two consumers
            // (pipe + data listener) coexist — Node's readable streams emit
            // 'data' to all listeners regardless of pipe.
            if (
              isMessagesRequest &&
              upRes.statusCode &&
              upRes.statusCode >= 200 &&
              upRes.statusCode < 300
            ) {
              const contentType = (upRes.headers['content-type'] || '')
                .toString()
                .toLowerCase();
              const usage = newUsage();
              const fireOnEnd = () => {
                try {
                  const agent = getAgentForIp(containerIp);
                  logger.info(
                    {
                      status: upRes.statusCode,
                      contentType,
                      ip: normalizeIp(containerIp),
                      agent,
                      hasUsage: hasUsage(usage),
                      input: usage.input_tokens,
                      output: usage.output_tokens,
                      cacheRead: usage.cache_read_input_tokens,
                      cacheCreate: usage.cache_creation_input_tokens,
                      model: usage.model,
                      session_id: usage.session_id,
                    },
                    'Captured Anthropic usage',
                  );
                  postUsageToVan(usage, agent);
                  postUsageToKernel(usage, agent);
                } catch (err) {
                  logger.warn({ err }, 'Token-usage POST scheduling failed');
                }
              };

              if (contentType.includes('text/event-stream')) {
                // SSE: parse line-by-line as chunks arrive.
                let buf = '';
                let dataLineCount = 0;
                let bytesSeen = 0;
                upRes.on('data', (chunk: Buffer) => {
                  try {
                    bytesSeen += chunk.length;
                    buf += chunk.toString('utf8');
                    let nl: number;
                    while ((nl = buf.indexOf('\n')) !== -1) {
                      const line = buf.slice(0, nl).replace(/\r$/, '');
                      buf = buf.slice(nl + 1);
                      if (line.startsWith('data:')) {
                        dataLineCount++;
                        const data = line.slice(5).replace(/^\s+/, '');
                        applySseEvent(usage, data);
                      }
                    }
                  } catch (err) {
                    logger.warn({ err }, 'SSE parse failed — continuing');
                  }
                });
                upRes.on('end', () => {
                  if (dataLineCount === 0) {
                    logger.warn(
                      {
                        bytesSeen,
                        contentEncoding: upRes.headers['content-encoding'],
                      },
                      'SSE stream had zero data: events',
                    );
                  }
                  fireOnEnd();
                });
                upRes.on('error', () => {
                  /* never affect the proxied response */
                });
              } else if (contentType.includes('application/json')) {
                // Non-streaming: buffer and parse on end.
                const respChunks: Buffer[] = [];
                let size = 0;
                let truncated = false;
                upRes.on('data', (chunk: Buffer) => {
                  if (truncated) return;
                  size += chunk.length;
                  if (size > MAX_BUFFERED_BODY) {
                    truncated = true;
                    respChunks.length = 0;
                    return;
                  }
                  respChunks.push(chunk);
                });
                upRes.on('end', () => {
                  if (!truncated) {
                    try {
                      applyJsonBody(
                        usage,
                        Buffer.concat(respChunks).toString('utf8'),
                      );
                    } catch (err) {
                      logger.warn({ err }, 'JSON usage parse failed');
                    }
                  }
                  fireOnEnd();
                });
                upRes.on('error', () => {
                  /* never affect the proxied response */
                });
              }
              // Other content types: skip — no usage possible.
            }

            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
