import { createServer } from 'node:http';

const seen = [];
let okRounds = 0;

function rpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  { name: 'headers', description: 'returns the request headers', inputSchema: { type: 'object' } },
  {
    name: 'err',
    description: 'a JSON-RPC error quoting the headers',
    inputSchema: { type: 'object' },
  },
  {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
  { name: 'rich', description: 'every content type', inputSchema: { type: 'object' } },
  { name: 'structured', description: 'structured only', inputSchema: { type: 'object' } },
  { name: 'nested', description: 'JSON inside a string', inputSchema: { type: 'object' } },
  { name: 'failed', description: 'a tool error', inputSchema: { type: 'object' } },
  { name: 'count', description: 'a number', inputSchema: { type: 'object' } },
];

function richResult(quoted) {
  return {
    content: [
      { type: 'text', text: quoted },
      { type: 'resource', resource: { uri: 'mem://r', text: quoted } },
      { type: 'resource_link', uri: `mem://${quoted}`, name: 'link' },
    ],
    structuredContent: { value: quoted, [quoted]: 'key' },
  };
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.url === '/seen') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seen));
      return;
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const bare = req.url.startsWith('/tok');
    const url = bare ? req.url.slice(4) : req.url;
    const quoted = bare
      ? `token ${(req.headers.authorization ?? '').slice(7)} key ${req.headers['x-key'] ?? ''}`
      : JSON.stringify(req.headers);
    if (url.startsWith('/long500')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`${'x'.repeat(501)} ${quoted}`);
      return;
    }
    if (url.startsWith('/500')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`boom ${quoted}`);
      return;
    }
    if (url.startsWith('/403')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`denied ${quoted}`);
      return;
    }
    if (url.startsWith('/401')) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(`bad credentials ${quoted}`);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let out;
    if (url.startsWith('/ask') && method === 'server/discover') {
      out = rpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'reflect', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    } else if (url.startsWith('/ask') && method === 'tasks/get') {
      out = rpc(id, {
        taskId: params?.taskId,
        status: 'completed',
        result: { content: [{ type: 'text', text: quoted }] },
      });
    } else if (url.startsWith('/ask') && method === 'tasks/cancel') {
      out = rpc(id, { taskId: params?.taskId, status: 'cancelled' });
    } else if (url.startsWith('/ask-ok') && method === 'tools/call') {
      const ask = { message: 'need input', schema: { type: 'object', properties: {} } };
      out =
        okRounds++ % 2 === 1
          ? rpc(id, { content: [{ type: 'text', text: quoted }] })
          : rpc(id, { resultType: 'input_required', inputRequest: ask });
    } else if (url.startsWith('/ask') && method === 'tools/call') {
      const ask = {
        message: `need input ${quoted}`,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string', description: `about ${quoted}` } },
        },
      };
      out = params?.inputResponses
        ? rpcError(id, -32000, `retry failed ${quoted}`)
        : rpc(id, {
            resultType: 'input_required',
            content: [{ type: 'text', text: quoted }],
            ...(params?.arguments?.bare ? {} : { inputRequest: ask }),
          });
    } else if (method === 'initialize') {
      out = rpc(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} },
        serverInfo: { name: 'reflect', version: '1.0.0' },
        instructions: quoted,
      });
    } else if (method === 'tools/list' && url.includes('badlist')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`boom ${quoted}`);
      return;
    } else if (method === 'tools/list' && url.includes('listed')) {
      const token = (req.headers.authorization ?? '').slice(7);
      const tool = {
        name: `echo_${token}`,
        description: `quoting ${quoted}`,
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string', description: `about ${quoted}` } },
        },
      };
      out = rpc(id, { tools: [tool] });
    } else if (method === 'tools/list') {
      out = rpc(id, { tools: TOOLS });
    } else if (method === 'tools/call' && params?.name === 'headers') {
      out = rpc(id, { content: [{ type: 'text', text: quoted }] });
    } else if (method === 'tools/call' && params?.name === 'err') {
      out = rpcError(id, -32000, `bad ${quoted}`);
    } else if (method === 'tools/call' && params?.name === 'rich') {
      out = rpc(id, richResult(quoted));
    } else if (method === 'tools/call' && params?.name === 'structured') {
      out = rpc(id, { content: [], structuredContent: { value: quoted } });
    } else if (method === 'tools/call' && params?.name === 'nested') {
      const inner = JSON.stringify({ quoted });
      out = rpc(id, { content: [{ type: 'text', text: JSON.stringify({ inner }) }] });
    } else if (method === 'tools/call' && params?.name === 'failed') {
      out = rpc(id, { isError: true, content: [{ type: 'text', text: quoted }] });
    } else if (method === 'tools/call' && params?.name === 'count') {
      out = rpc(id, {
        content: [{ type: 'text', text: 'plain' }],
        structuredContent: { count: 1, label: 'plain' },
      });
    } else if (method === 'resources/list') {
      out = rpc(id, { resources: [{ uri: 'mem://r', name: quoted, description: quoted }] });
    } else if (method === 'resources/templates/list') {
      out = rpc(id, { resourceTemplates: [] });
    } else if (method === 'resources/read') {
      out = rpc(id, { contents: [{ uri: params?.uri, text: quoted }] });
    } else if (method === 'prompts/list') {
      out = rpc(id, { prompts: [{ name: 'p', description: quoted }] });
    } else if (method === 'prompts/get') {
      out = rpc(id, {
        description: quoted,
        messages: [{ role: 'user', content: { type: 'text', text: quoted } }],
      });
    } else if (method === 'completion/complete') {
      out = rpc(id, { completion: { values: [quoted] } });
    } else if (method === 'tools/call' && params?.name === 'echo') {
      out = rpc(id, {
        content: [{ type: 'text', text: String(params?.arguments?.message ?? '') }],
      });
    } else if (method === 'ping') {
      out = rpc(id, {});
    } else {
      out = rpcError(id, -32601, 'not found');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out);
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
process.on('SIGTERM', () => process.exit(0));
