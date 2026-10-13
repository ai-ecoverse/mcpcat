import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as readline from 'node:readline';

const pidFile = process.argv[2];
if (!pidFile) {
  process.stderr.write('Usage: server-slow-grandchild.mjs <pid-file>\n');
  process.exit(1);
}

const grandchild = spawn('sleep', ['300'], { detached: false, stdio: 'ignore' });
writeFileSync(pidFile, `${process.pid}\n${grandchild.pid}\n`);

const TOOLS = [
  {
    name: 'slow',
    description: 'Sleeps then returns',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer' } },
      required: ['ms'],
    },
  },
];

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

  switch (method) {
    case 'initialize':
      process.stdout.write(
        `${jsonRpc(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'test-slow-grandchild', version: '1.0.0' },
        })}\n`
      );
      break;
    case 'tools/list':
      process.stdout.write(`${jsonRpc(id, { tools: TOOLS })}\n`);
      break;
    case 'tools/call': {
      const ms = params?.arguments?.ms ?? 30000;
      setTimeout(() => {
        process.stdout.write(
          `${jsonRpc(id, {
            content: [{ type: 'text', text: `slept ${ms}ms` }],
          })}\n`
        );
      }, ms);
      break;
    }
    default:
      process.stdout.write(`${jsonRpcError(id, -32601, `Method not found: ${method}`)}\n`);
  }
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
