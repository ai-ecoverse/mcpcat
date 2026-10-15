import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNodeKernel, hostUrl, kernelAtLeast, nodeTransport } from './helpers/kernel.mjs';
import { fixtures, root, startFixture } from './helpers/rows.mjs';

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ALICE = '/home/alice/.pi/agent/mcp.json';

async function install(kernel, name, module, data) {
  await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${module}`, data);
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${name}/package.json`,
    JSON.stringify({
      name: `@ai-ecoverse/${name}`,
      version: name === 'mcpcat' ? pkg.version : '1.0.0',
      type: 'module',
      slicc: { commands: { [name]: { abi: 'js', module } } },
    })
  );
}

const run = (kernel, argv, opts = {}) =>
  kernel.run(argv, { stdout: 'pipe', stderr: 'pipe', ...opts });

describe('cert row: DAC under users enforce (alice and bob)', {
  skip: !kernelAtLeast(74) && 'users need slicc-kernel >= 1.74.0',
}, () => {
  let srv;
  let kernel;
  let before0;
  let url;

  before(async () => {
    srv = await startFixture('server-2026-http.mjs');
    kernel = await createNodeKernel({
      users: 'enforce',
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await install(
      kernel,
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm',
      readFileSync(join(root, 'dist/quickjs.wasm'))
    );
    await install(
      kernel,
      'kernel-cert-cat',
      'main.mjs',
      readFileSync(join(fixtures, 'kernel-cert-cat.mjs'))
    );
    await install(
      kernel,
      'kernel-cert-walk',
      'main.mjs',
      readFileSync(join(fixtures, 'kernel-cert-walk.mjs'))
    );
    await kernel.users.add({ name: 'alice' });
    await kernel.users.add({ name: 'bob' });
    before0 = (await run(kernel, ['kernel-cert-walk'])).stdout.trim().split('\n');
    url = `${hostUrl(srv.port)}/mcp`;
  });

  after(() => {
    kernel?.terminate();
    srv?.child.kill('SIGTERM');
  });

  it("alice's ten parallel adds all land in her mcp.json, and she can use them", async () => {
    const adds = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        run(kernel, ['mcpcat', 'add', `s${i}`, url], { user: 'alice' })
      )
    );
    assert.deepEqual(
      adds.filter((a) => a.status !== 0).map((a) => a.stderr),
      []
    );
    const cfg = await run(kernel, ['kernel-cert-cat', ALICE], { user: 'alice' });
    assert.equal(Object.keys(JSON.parse(cfg.stdout).mcpServers).length, 10);
    const tools = await run(kernel, ['mcpcat', 'tools', 's3'], { user: 'alice' });
    assert.equal(tools.status, 0, tools.stderr);
  });

  it('alice writes nothing outside her home and /tmp', async () => {
    const now = (await run(kernel, ['kernel-cert-walk'])).stdout.trim().split('\n');
    assert.ok(before0.length > 10, 'the walk saw almost nothing');
    const changed = now.filter((l) => !before0.includes(l)).map((l) => l.split('\t')[0]);
    assert.deepEqual(
      changed.filter((p) => !p.startsWith('/home/alice') && !p.startsWith('/tmp')),
      []
    );
  });

  for (const [name, argv, env] of [
    ['with HOME=/home/alice', ['mcpcat', 'tools', 's3'], { HOME: '/home/alice' }],
    [
      'with PI_CODING_AGENT_DIR in her home',
      ['mcpcat', 'tools', 's3'],
      { PI_CODING_AGENT_DIR: '/home/alice/.pi/agent' },
    ],
    ['with --config first', ['mcpcat', '--config', ALICE, 'tools', 's3']],
    ['with --config last', ['mcpcat', 'tools', 's3', '--config', ALICE]],
    ['with a file:server target', ['mcpcat', 'tools', `${ALICE}:s3`]],
    ['with import', ['mcpcat', 'import', ALICE]],
  ]) {
    it(`bob cannot use alice's servers ${name}`, async () => {
      const r = await run(kernel, argv, { user: 'bob', ...(env ? { env } : {}) });
      assert.notEqual(r.status, 0, r.stdout);
    });
  }
});
