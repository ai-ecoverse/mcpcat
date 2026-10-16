import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';
import { root, startFixture } from './helpers/rows.mjs';

const MARK = 'certrowKernelSecretH4w8Pq';
const AGENT_DIR = '/etc/mcpcat-cert-row';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('cert row: secrets redaction in the kernel', () => {
  let srv;
  let kernel;
  let base;
  const header = ['-H', 'X-Api: ${CERT_ROW_TOKEN}'];
  const env = { CERT_ROW_TOKEN: MARK, PI_CODING_AGENT_DIR: AGENT_DIR };
  const run = (argv) => kernel.run(['mcpcat', ...argv], { stdout: 'pipe', stderr: 'pipe', env });

  before(async () => {
    srv = await startFixture('cert-reflect.mjs');
    base = hostUrl(srv.port);
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat',
        version: pkg.version,
        type: 'module',
        slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
      })
    );
    await kernel.writeFile(
      `${AGENT_DIR}/mcp.json`,
      JSON.stringify({
        mcpServers: {
          r: { url: `${base}/mcp`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
          r500: { url: `${base}/500`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
          r403: { url: `${base}/403`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
          r401: { url: `${base}/401`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
        },
      })
    );
  });

  after(() => {
    kernel?.terminate();
    srv?.child.kill('SIGTERM');
  });

  const cases = {
    'a JSON-RPC error quoting -H': () => [...header, 'call', `${base}/mcp`, 'err'],
    'a JSON-RPC error quoting -H, --json': () => [
      ...header,
      '--json',
      'call',
      `${base}/mcp`,
      'err',
    ],
    'a JSON-RPC error quoting -H, -v': () => [...header, '-v', 'call', `${base}/mcp`, 'err'],
    'a successful call with -H, -v': () => [
      ...header,
      '-v',
      'call',
      `${base}/mcp`,
      'echo',
      '-d',
      '{"message":"hi"}',
    ],
    'tools with -H, -v': () => [...header, '-v', 'tools', `${base}/mcp`],
    'HTTP 500 quoting -H, -v': () => [...header, '-v', 'call', `${base}/500`, 'echo'],
    'HTTP 403 quoting -H, --json': () => [...header, '--json', 'call', `${base}/403`, 'echo'],
    'HTTP 401 quoting -H, -v': () => [...header, '-v', 'call', `${base}/401`, 'echo'],
    'mcp.json ${VAR}, JSON-RPC error, -v': () => ['-v', 'call', 'r', 'err'],
    'mcp.json ${VAR}, successful call, -v': () => [
      '-v',
      'call',
      'r',
      'echo',
      '-d',
      '{"message":"hi"}',
    ],
    'mcp.json ${VAR}, HTTP 500': () => ['call', 'r500', 'echo'],
    'mcp.json ${VAR}, HTTP 403, --json': () => ['--json', 'call', 'r403', 'echo'],
    'mcp.json ${VAR}, HTTP 401, -v': () => ['-v', 'call', 'r401', 'echo'],
  };

  for (const [name, args] of Object.entries(cases)) {
    it(`never prints the value: ${name}`, async () => {
      const r = await run(args());
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
    });
  }

  it('delivers the expanded value to the server', async () => {
    const r = await run([...header, 'call', `${base}/mcp`, 'echo', '-d', '{"message":"x"}']);
    assert.equal(r.status, 0, r.stderr);
    const seen = await (await fetch(`http://127.0.0.1:${srv.port}/seen`)).json();
    assert.ok(seen.some((e) => e.headers['x-api'] === MARK));
  });
});
