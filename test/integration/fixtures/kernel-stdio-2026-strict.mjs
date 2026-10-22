const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const PV = 'io.modelcontextprotocol/protocolVersion';
const CI = 'io.modelcontextprotocol/clientInfo';
const CC = 'io.modelcontextprotocol/clientCapabilities';
const SI = 'io.modelcontextprotocol/serverInfo';
const NAMED = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the input back',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
  {
    name: '天気',
    description: 'Weather in Japanese',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
];
const RESOURCES = [{ uri: 'file:///notes/ü.txt', name: 'umlaut', mimeType: 'text/plain' }];
const PROMPTS = [{ name: 'greet', description: 'Greets' }];

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function decodeHeader(value) {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const bin = atob(value.slice(9, -2));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function headerSafe(value) {
  return (
    /^[\x20-\x7e\t]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith('=?base64?') && value.endsWith('?='))
  );
}

export function modernViolation(msg, headers) {
  const params = msg.params;
  const bad = (message) => ({ status: 400, code: -32602, message: `Invalid params: ${message}` });
  if (!isObject(params)) return bad('params missing');
  const meta = params._meta;
  if (!isObject(meta)) return bad('_meta missing');
  for (const key of ['protocolVersion', 'clientInfo', 'clientCapabilities']) {
    if (key in meta) return bad(`unprefixed _meta.${key}`);
  }
  if (typeof meta[PV] !== 'string') return bad(`${PV} missing`);
  if (!isObject(meta[CC])) return bad(`${CC} missing`);
  if (CI in meta && (!isObject(meta[CI]) || typeof meta[CI].name !== 'string')) {
    return bad(`${CI} malformed`);
  }
  if (msg.method === 'server/discover' && 'protocolVersion' in params) {
    return bad('server/discover takes no protocolVersion');
  }
  if ('inputResponses' in meta) return bad('inputResponses belongs in params');
  if (headers) {
    const mismatch = (message) => ({
      status: 400,
      code: -32020,
      message: `Header mismatch: ${message}`,
    });
    const accept = headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return { status: 400, code: -32600, message: 'Accept must list both content types' };
    }
    if (headers['mcp-protocol-version'] !== meta[PV]) return mismatch('MCP-Protocol-Version');
    if (headers['mcp-method'] !== msg.method) return mismatch('Mcp-Method');
    const field = NAMED[msg.method];
    if (field) {
      const raw = headers['mcp-name'];
      if (typeof raw !== 'string') return mismatch('Mcp-Name missing');
      const expected = params[field];
      if (!headerSafe(expected) && !raw.startsWith('=?base64?'))
        return mismatch('Mcp-Name not encoded');
      if (decodeHeader(raw) !== expected) return mismatch('Mcp-Name');
    }
  }
  if (meta[PV] !== MODERN) {
    return {
      status: 400,
      code: -32022,
      message: 'Unsupported protocol version',
      data: { supported: [MODERN], requested: meta[PV] },
    };
  }
  return null;
}

function ok(id, result, modern) {
  const body = modern ? { resultType: 'complete', ...result } : result;
  return { status: 200, response: { jsonrpc: '2.0', id, result: body } };
}

function fail(id, status, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return { status, response: { jsonrpc: '2.0', id, error } };
}

function common(msg, modern, name) {
  const { id, method, params } = msg;
  if (method === 'ping') return ok(id, {}, modern);
  if (method === 'tools/list') return ok(id, { tools: TOOLS }, modern);
  if (method === 'resources/list') return ok(id, { resources: RESOURCES }, modern);
  if (method === 'prompts/list') return ok(id, { prompts: PROMPTS }, modern);
  if (method === 'tools/call') {
    const text =
      params?.name === 'echo' ? String(params?.arguments?.message ?? '') : `tool:${params?.name}`;
    const extra = params?.inputResponses ? ` answers:${JSON.stringify(params.inputResponses)}` : '';
    return ok(id, { content: [{ type: 'text', text: `${name}:${text}${extra}` }] }, modern);
  }
  if (method === 'resources/read') {
    return ok(
      id,
      { contents: [{ uri: params?.uri, mimeType: 'text/plain', text: `read:${params?.uri}` }] },
      modern
    );
  }
  if (method === 'prompts/get') {
    return ok(
      id,
      { messages: [{ role: 'user', content: { type: 'text', text: `prompt:${params?.name}` } }] },
      modern
    );
  }
  return fail(id, modern ? 404 : 200, -32601, `Method not found: ${method}`);
}

export function createStrictServer({ dual = false, reject, name = 'strict' } = {}) {
  const log = [];
  const sessions = new Set();
  let stdioLegacy = false;
  let counter = 0;

  function handle(msg, headers) {
    const sid = headers?.['mcp-session-id'];
    const legacy = headers ? !!sid && sessions.has(sid) : stdioLegacy;
    log.push({
      method: msg.method,
      id: msg.id,
      era: msg.method === 'initialize' || legacy ? 'legacy' : 'modern',
      protocolHeader: headers?.['mcp-protocol-version'],
      nameHeader: headers?.['mcp-name'],
      meta: msg.params?._meta,
    });
    if (msg.method === 'initialize') {
      if (!dual) {
        return fail(
          msg.id,
          400,
          -32601,
          `initialize is not supported; supported versions: ${MODERN}`
        );
      }
      const requested = msg.params?.protocolVersion;
      const protocolVersion = LEGACY.includes(requested) ? requested : LEGACY[0];
      const out = ok(
        msg.id,
        {
          protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: `${name}-legacy`, version: '1.0.0' },
        },
        false
      );
      if (headers) {
        const id = `s-${++counter}`;
        sessions.add(id);
        out.sessionId = id;
      } else {
        stdioLegacy = true;
      }
      return out;
    }
    if (legacy) {
      if (!('id' in msg)) return { status: 202, response: null };
      return common(msg, false, `${name}-legacy`);
    }
    if (!('id' in msg)) return { status: 202, response: null };
    if (reject !== undefined) return fail(msg.id, 400, reject, 'Rejected by fixture');
    const violation = modernViolation(msg, headers);
    if (violation)
      return fail(msg.id, violation.status, violation.code, violation.message, violation.data);
    if (msg.method === 'server/discover') {
      return ok(
        msg.id,
        {
          supportedVersions: dual ? [MODERN, ...LEGACY] : [MODERN],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          _meta: { [SI]: { name: `${name}-modern`, version: '1.0.0' } },
        },
        true
      );
    }
    return common(msg, true, `${name}-modern`);
  }

  return { handle, log };
}

export function parseOptions(argv) {
  const rejectArg = argv.find((a) => a.startsWith('--reject='));
  return {
    dual: argv.includes('--dual'),
    reject: rejectArg ? Number(rejectArg.slice(9)) : undefined,
  };
}

export default async function main(ctx) {
  const server = createStrictServer(parseOptions(ctx.argv));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.trim()) continue;
        const { response } = server.handle(JSON.parse(line));
        if (response) await writer.write(encoder.encode(`${JSON.stringify(response)}\n`));
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
  return 0;
}
