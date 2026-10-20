import * as readline from 'node:readline';

const EVIL = 'boom \x1b]0;pwned\x07 \x1b[2J \x9b31m end';
const SERVER_INFO = { name: 'evil-stdio-2026', version: '1.0.0' };
const inputSchema = { type: 'object', properties: {} };

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function answered(params) {
  return Boolean(
    params?._inputResponses ??
      params?._meta?.inputResponses ??
      params?.arguments?._meta?.inputResponses
  );
}

function inputRequest(name) {
  if (name === 'ask-url') return { url: `https://example.com/${EVIL}` };
  return {
    message: EVIL,
    schema: {
      type: 'object',
      properties: {
        [`key ${EVIL}`]: { type: 'string', description: EVIL, enum: [EVIL, 'b'], default: EVIL },
      },
    },
  };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'server/discover') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28'],
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'ask', inputSchema },
          { name: 'ask-url', inputSchema },
        ],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    if (answered(params)) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'done' }] } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'input_required',
        content: [{ type: 'text', text: 'input needed' }],
        inputRequest: inputRequest(params?.name),
      },
    });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

rl.on('close', () => process.exit(0));
