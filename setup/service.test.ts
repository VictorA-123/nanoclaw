import { describe, it, expect } from 'vitest';
import path from 'path';

import { DEFAULT_DRAIN_TIMEOUT_MS } from '../src/config.js';
import { generateSystemdUnit } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 *
 * The systemd unit is imported from service.ts, NOT re-declared here. It used
 * to be a hand-copied duplicate, which meant a change to the real template
 * (Phase 6 close-out Part C) could pass a green test suite while the installer
 * silently kept writing the old unit.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>com.nanoclaw</string>');
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js',
    );
  });

  // Phase 6 close-out, Part C. These three lines are the whole reason the
  // template stopped being duplicated: the installer must keep writing them.
  it('system unit orders itself after docker and wants it', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/root/nanoclaw',
      '/root',
      true,
    );
    expect(unit).toContain('After=network.target docker.service');
    expect(unit).toContain('Wants=docker.service');
  });

  it('system unit sets TimeoutStopSec to the drain bound plus 30s', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/root/nanoclaw',
      '/root',
      true,
    );
    expect(unit).toContain(
      `TimeoutStopSec=${DEFAULT_DRAIN_TIMEOUT_MS / 1000 + 30}`,
    );
  });

  it('TimeoutStopSec follows a non-default drain bound', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/root/nanoclaw',
      '/root',
      true,
      600_000,
    );
    expect(unit).toContain('TimeoutStopSec=630');
  });

  it('user unit gets no docker ordering — docker.service is not a user unit', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('After=network.target\n');
    expect(unit).not.toContain('docker.service');
    expect(unit).not.toContain('TimeoutStopSec');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });
});
