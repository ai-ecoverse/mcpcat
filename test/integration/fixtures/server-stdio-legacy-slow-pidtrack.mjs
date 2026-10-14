#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import * as readline from 'node:readline';

const pidFile = process.env.PID_RECORD_FILE;
if (pidFile) {
  appendFileSync(pidFile, `server:${process.pid}\n`);
}

const grandchild = spawn('sleep', ['300'], { detached: false, stdio: 'ignore' });
if (pidFile) {
  appendFileSync(pidFile, `grandchild:${grandchild.pid}\n`);
}

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stdout.write(`${jsonRpcError(null, -32700, 'Parse error')}\n`);
    return;
  }

  const { id, method, params } = parsed;
  if (method === 'notifications/initialized') return;

  let response;
  switch (method) {
    case 'initialize':
      response = jsonRpc(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test-legacy-slow-pidtrack', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      response = jsonRpc(id, {
        tools: [
          {
            name: 'slow',
            description: 'Responds after a delay',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
      break;
    case 'tools/call':
      setTimeout(() => {
        process.stdout.write(`${jsonRpc(id, { content: [{ type: 'text', text: 'done' }] })}\n`);
      }, 30000);
      return;
    default:
      response = jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  process.stdout.write(`${response}\n`);
});

rl.on('close', () => {
  try {
    grandchild.kill('SIGTERM');
  } catch {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  try {
    grandchild.kill('SIGTERM');
  } catch {}
  process.exit(0);
});
