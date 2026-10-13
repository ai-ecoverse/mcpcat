import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as readline from 'node:readline';

const pidFile = process.argv[2];
if (!pidFile) {
  process.stderr.write('Usage: server-stdio-grandchild.mjs <pid-file>\n');
  process.exit(1);
}

const grandchild = spawn('sleep', ['300'], { detached: false, stdio: 'ignore' });
writeFileSync(pidFile, `${process.pid}\n${grandchild.pid}\n`);

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the input back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
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

  let response;
  switch (method) {
    case 'initialize':
      response = jsonRpc(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test-stdio-grandchild', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      response = jsonRpc(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'echo') {
        response = jsonRpc(id, {
          content: [{ type: 'text', text: args.message ?? '' }],
        });
      } else {
        response = jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      break;
    }
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
