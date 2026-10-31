import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createNodeKernel, hasSealedFetch, nodeTransport } from './kernel.mjs';
import { fixtures, root } from './rows.mjs';

export const AGENT_DIR = '/etc/mcpcat-537';
export const CONFIG = `${AGENT_DIR}/mcp.json`;
export const SEALED = /fnox_proxy_[0-9a-f]{24}/;

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const jerkEpochs = new WeakMap();
const TOOL = { name: 'whoami', description: 'who', inputSchema: { type: 'object' } };

function rpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function answer(url, { id, method }) {
  if (method === 'server/discover') {
    if (url.includes('/modern')) {
      return rpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'gated', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } });
  }
  if (method === 'initialize') {
    return rpc(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'gated', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') return rpc(id, { tools: [TOOL], resultType: 'complete' });
  if (method === 'tools/call') {
    return rpc(id, { content: [{ type: 'text', text: 'served' }], resultType: 'complete' });
  }
  return rpc(id, {});
}

export async function gatedServer(credential) {
  const seen = [];
  const gate = { seen, status: 401, headers: {} };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      const open = req.url.startsWith('/open');
      if (!open && req.headers.authorization !== `Bearer ${credential.value}`) {
        res.writeHead(gate.status, { 'content-type': 'text/plain', ...gate.headers });
        res.end('bad credentials');
        return;
      }
      const msg = body ? JSON.parse(body) : {};
      if (req.method !== 'POST' || msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer(req.url, msg));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(gate, { port: server.address().port, close: () => server.close() });
}

export function sealedExit(port, fill) {
  const inner = nodeTransport({ hostLoopback: true });
  const offered = [];
  const local = (url) => {
    const u = new URL(url);
    return `http://127.0.0.1:${port}${u.pathname}`;
  };
  const refused = (status, reason) => ({
    status,
    statusText: 'Forbidden',
    headers: [['content-type', 'text/plain']],
    body: (async function* () {
      yield new TextEncoder().encode(reason);
    })(),
    cancel: async () => {},
  });
  const transport = {
    ...inner,
    async fetch(request) {
      const headers = [...request.headers];
      offered.push({ url: request.url, headers });
      if (!headers.some(([name, value]) => SEALED.test(`${name}:${value}`))) {
        return inner.fetch({ ...request, url: local(request.url) });
      }
      const body = request.body ? new TextDecoder().decode(request.body) : undefined;
      const reply = await fill({ method: request.method, url: request.url, headers }, body);
      if (reply.refused) return refused(reply.refused.status, reply.refused.reason);
      return inner.fetch({
        ...request,
        url: local(reply.head.url),
        headers: reply.head.headers,
        body: reply.body === undefined ? request.body : new TextEncoder().encode(reply.body),
      });
    },
  };
  const fetch = ({ method, url, headers, body, bodyStream }, { signal }) =>
    transport.fetch({ method, url, headers, body, bodyStream, signal });
  return { transport, fetch, offered };
}

function sealedOption(exit, sealed, fills) {
  if (!fills || !hasSealedFetch) return sealed ? { sealed } : {};
  const request = sealed ?? (async () => ({ v: 1, error: { code: 'ENOTCONN' } }));
  return { users: 'enforce', sealed: { request, fetch: exit.fetch } };
}

export async function bootKernel(
  exit,
  servers,
  { jerk = true, sealed, fills = true, ...options } = {}
) {
  const kernel = await createNodeKernel({
    network: { transport: exit.transport },
    ...sealedOption(exit, sealed, fills),
    ...options,
  });
  const install = async (name, command, module, data) => {
    await kernel.writeFile(`/node_modules/${name}/${module}`, data);
    await kernel.writeFile(
      `/node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: pkg.version,
        type: 'module',
        slicc: { commands: { [command]: { abi: 'js', module } } },
      })
    );
  };
  await install(
    '@ai-ecoverse/mcpcat',
    'mcpcat',
    'dist/kernel/mcpcat.mjs',
    readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
  );
  if (jerk) {
    await install(
      '@ai-ecoverse/slicc-jerk',
      'jerk',
      'dist/jerk.mjs',
      readFileSync(join(fixtures, 'kernel-fake-jerk.mjs'))
    );
  }
  await kernel.writeFile(CONFIG, JSON.stringify({ mcpServers: servers }));
  return kernel;
}

export async function jerkAnswers(kernel, get, list) {
  jerkEpochs.set(kernel, (jerkEpochs.get(kernel) ?? 0) + 1);
  await kernel.writeFile('/etc/fake-jerk.json', JSON.stringify({ get, list }));
}

export async function jerkLog(kernel) {
  const { stdout } = await kernel.run(['jerk', '--log', String(jerkEpochs.get(kernel))], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return stdout.split('\n').filter(Boolean);
}

export function standInVault(answers) {
  const vault = { requests: [], answer: answers };
  vault.sealed = async (request) => {
    vault.requests.push(structuredClone(request));
    return vault.answer(request);
  };
  return vault;
}

export function listed(...names) {
  return names.map((name) => ({ provider: `mcp:${name}`, name, source: 'seven' }));
}

export function mcpcat(kernel, env, options = {}) {
  return (...args) =>
    kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PI_CODING_AGENT_DIR: AGENT_DIR,
        FAKE_JERK_EPOCH: String(jerkEpochs.get(kernel)),
        ...env,
      },
      ...options,
    });
}

export function assertNoValue(value, ...texts) {
  for (const text of texts) assert.ok(!text.includes(value), 'the value reached mcpcat');
}
