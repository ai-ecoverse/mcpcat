import { createServer } from 'node:http';
import { modernViolation } from './kernel-stdio-2026-strict.mjs';

const SERVER_INFO = {
  name: 'test-2026',
  version: '1.0.0',
  title: 'Test Server (2026-07-28)',
};

const RESOURCES = [
  {
    uri: 'file:///readme.txt',
    name: 'readme',
    description: 'A readme file',
    mimeType: 'text/plain',
  },
  {
    uri: 'file:///logo.png',
    name: 'logo',
    description: 'A logo image',
    mimeType: 'image/png',
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'file:///docs/{name}',
    name: 'docs',
    description: 'Documentation files',
  },
];

const PROMPTS = [
  {
    name: 'greet',
    description: 'Generate a greeting',
    arguments: [
      { name: 'name', description: 'Name to greet', required: true },
      { name: 'style', description: 'Greeting style' },
    ],
  },
  {
    name: 'summarize',
    description: 'Summarize text',
    arguments: [{ name: 'text', description: 'Text to summarize', required: true }],
  },
];

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the input back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Message to echo' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'fail',
    description: 'Always returns an error',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'needs-input',
    description: 'Returns input_required resultType',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'weather',
    description: 'Get weather forecast',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        days: { type: 'integer', description: 'Number of days' },
        verbose: { type: 'boolean', description: 'Verbose output' },
      },
      required: ['city'],
    },
  },
  {
    name: 'image-tool',
    description: 'Returns an image',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resource-link-tool',
    description: 'Returns a resource link',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'structured-tool',
    description: 'Returns structured content',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'multi-content',
    description: 'Returns multiple content blocks',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Sleeps for a while',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
  },
];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message, data) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function handleRequest(body, headers) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, body: jsonRpcError(null, -32700, 'Parse error') };
  }
  const violation = modernViolation(parsed, headers);
  if (violation) {
    return {
      status: violation.status,
      body: jsonRpcError(parsed.id, violation.code, violation.message, violation.data),
    };
  }
  const result = dispatch(parsed);
  return result instanceof Promise
    ? result.then((out) => ({ status: 200, body: out }))
    : { status: 200, body: result };
}

function dispatch(parsed) {
  const { id, method, params } = parsed;

  switch (method) {
    case 'server/discover':
      return jsonRpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        instructions: 'A test server for integration tests.',
      });

    case 'tools/list':
      return jsonRpc(id, { tools: TOOLS });

    case 'resources/list':
      return jsonRpc(id, { resources: RESOURCES });

    case 'resources/templates/list':
      return jsonRpc(id, { resourceTemplates: RESOURCE_TEMPLATES });

    case 'resources/read': {
      const uri = params?.uri;
      if (uri === 'file:///readme.txt') {
        return jsonRpc(id, {
          contents: [{ uri, mimeType: 'text/plain', text: 'Hello from readme' }],
        });
      }
      if (uri === 'file:///logo.png') {
        return jsonRpc(id, {
          contents: [{ uri, mimeType: 'image/png', blob: 'iVBORw0KGgo=' }],
        });
      }
      return jsonRpcError(id, -32602, `Resource not found: ${uri}`);
    }

    case 'prompts/list':
      return jsonRpc(id, { prompts: PROMPTS });

    case 'prompts/get': {
      const promptName = params?.name;
      const promptArgs = params?.arguments ?? {};
      if (promptName === 'greet') {
        const name = promptArgs.name ?? 'World';
        const style = promptArgs.style ?? 'friendly';
        return jsonRpc(id, {
          description: `A ${style} greeting`,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: `Say hello to ${name} in a ${style} way` },
            },
          ],
        });
      }
      if (promptName === 'summarize') {
        return jsonRpc(id, {
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: `Summarize: ${promptArgs.text ?? ''}` },
            },
          ],
        });
      }
      return jsonRpcError(id, -32602, `Unknown prompt: ${promptName}`);
    }

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'echo') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: args.message ?? '' }],
        });
      }
      if (toolName === 'add') {
        const sum = (args.a ?? 0) + (args.b ?? 0);
        return jsonRpc(id, {
          content: [{ type: 'text', text: String(sum) }],
        });
      }
      if (toolName === 'fail') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: 'something went wrong' }],
          isError: true,
        });
      }
      if (toolName === 'needs-input') {
        if (params?.inputResponses) {
          return jsonRpc(id, {
            content: [
              { type: 'text', text: `Got answer: ${JSON.stringify(params.inputResponses)}` },
            ],
          });
        }
        return jsonRpc(id, {
          resultType: 'input_required',
          content: [{ type: 'text', text: 'Please provide additional input' }],
          inputRequest: {
            message: 'Additional info needed',
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'Your answer' },
              },
              required: ['answer'],
            },
          },
        });
      }
      if (toolName === 'weather') {
        const city = args.city ?? 'unknown';
        const days = args.days ?? 1;
        const v = args.verbose ?? false;
        const text = v
          ? `Weather for ${city}: ${days} day(s), verbose mode`
          : `Weather for ${city}: ${days} day(s)`;
        return jsonRpc(id, { content: [{ type: 'text', text }] });
      }
      if (toolName === 'image-tool') {
        return jsonRpc(id, {
          content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
        });
      }
      if (toolName === 'resource-link-tool') {
        return jsonRpc(id, {
          content: [{ type: 'resource_link', uri: 'file:///example.txt', name: 'example' }],
        });
      }
      if (toolName === 'structured-tool') {
        return jsonRpc(id, {
          content: [],
          structuredContent: { result: 'structured', count: 42 },
        });
      }
      if (toolName === 'multi-content') {
        return jsonRpc(id, {
          content: [
            { type: 'text', text: 'First block' },
            { type: 'image', mimeType: 'image/jpeg', data: '/9j/' },
            { type: 'text', text: 'Last block' },
          ],
        });
      }
      if (toolName === 'slow') {
        const ms = args.ms ?? 5000;
        return new Promise((resolve) =>
          setTimeout(() => resolve(jsonRpc(id, { content: [{ type: 'text', text: 'done' }] })), ms)
        );
      }
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!req.headers['mcp-method']) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required Mcp-Method header' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString();
    const response = await handleRequest(body, req.headers);
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(response.body);
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ port, protocol: '2026-07-28', transport: 'http' }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
