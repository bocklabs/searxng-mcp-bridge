import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const buildPath = resolve(process.cwd(), 'build/index.js');

describe('stdio transport protocol', () => {
  let child: ChildProcess;

  afterEach(() => {
    child?.kill('SIGTERM');
  });

  it('keeps stdout reserved for JSON-RPC messages', async () => {
    child = spawn(process.execPath, [buildPath], {
      env: { ...process.env, SEARXNG_INSTANCE_URL: 'http://127.0.0.1:9' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    setTimeout(() => {
      child.stdin?.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'stdio-protocol-test', version: '1.0.0' }
        }
      })}\n`);
    }, 100);

    await vi.waitFor(() => {
      expect(stdout).toContain('"id":1');
    }, { timeout: 5000 });

    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages).toHaveLength(1);
    expect(messages[0].result.serverInfo.name).toBe('searxng-bridge');
  });
});
