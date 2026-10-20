import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { mcpcatArgs } from './helpers/bin.mjs';
import { createNodeKernel, kernelAtLeast } from './helpers/kernel.mjs';
import { fixtures, root } from './helpers/rows.mjs';

const mode = (path) => (statSync(path).mode & 0o777).toString(8);
const URL_ = 'https://mcp.example.com/mcp';

function mcpcat(args, env = {}) {
  const { cmd, args: argv } = mcpcatArgs(args);
  return execFileSync(cmd, argv, {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });
}

describe('mcp.json is private whatever the umask', { skip: process.platform === 'win32' }, () => {
  let umask;
  before(() => {
    umask = process.umask(0o022);
  });
  after(() => process.umask(umask));

  it('a first add under umask 022 writes mcp.json 0600 in a 0700 ~/.pi/agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcpcat-mode-'));
    mcpcat(['add', 'docs', URL_, '--no-probe'], { HOME: home });
    assert.equal(mode(join(home, '.pi/agent/mcp.json')), '600');
    assert.equal(mode(join(home, '.pi/agent')), '700');
  });

  it('an edit tightens a looser mcp.json and ~/.pi/agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcpcat-mode-'));
    const dir = join(home, '.pi/agent');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n', { mode: 0o644 });
    mcpcat(['add', 'docs', URL_, '--no-probe'], { HOME: home });
    assert.equal(mode(join(dir, 'mcp.json')), '600');
    assert.equal(mode(dir), '700');
    mcpcat(['rm', 'docs'], { HOME: home });
    assert.equal(mode(join(dir, 'mcp.json')), '600');
  });

  it('a --config file in a directory of its own is 0600, and the directory keeps its mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpcat-mode-'));
    chmodSync(dir, 0o755);
    const file = join(dir, 'servers.json');
    mcpcat(['add', 'docs', URL_, '--no-probe', '--config', file]);
    assert.equal(mode(file), '600');
    assert.equal(mode(dir), '755');
  });
});

describe('mcp.json is private for a kernel user with umask 022', {
  skip: !kernelAtLeast(74) && 'users need slicc-kernel >= 1.74.0',
}, () => {
  let kernel;
  const run = (argv, opts = {}) => kernel.run(argv, { stdout: 'pipe', stderr: 'pipe', ...opts });

  before(async () => {
    kernel = await createNodeKernel({ users: 'enforce' });
    for (const [name, module, data] of [
      ['mcpcat', 'dist/kernel/mcpcat.mjs', readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))],
      ['kernel-cert-stat', 'main.mjs', readFileSync(join(fixtures, 'kernel-cert-stat.mjs'))],
    ]) {
      await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${module}`, data);
      await kernel.writeFile(
        `/node_modules/@ai-ecoverse/${name}/package.json`,
        JSON.stringify({
          name: `@ai-ecoverse/${name}`,
          version: '1.0.0',
          type: 'module',
          slicc: { commands: { [name]: { abi: 'js', module } } },
        })
      );
    }
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm',
      readFileSync(join(root, 'dist/quickjs.wasm'))
    );
    await kernel.users.add({ name: 'cone', umask: 0o022 });
  });

  after(() => kernel?.terminate());

  it('cone’s mcpcat add writes mcp.json 0600 in a 0700 ~/.pi/agent', async () => {
    const added = await run(['mcpcat', 'add', 'docs', URL_, '--no-probe'], { user: 'cone' });
    assert.equal(added.status, 0, added.stderr);
    const stat = await run(
      ['kernel-cert-stat', '/home/cone/.pi/agent', '/home/cone/.pi/agent/mcp.json'],
      { user: 'cone' }
    );
    assert.equal(
      stat.stdout,
      '/home/cone/.pi/agent\t700\n/home/cone/.pi/agent/mcp.json\t600\n',
      stat.stderr
    );
  });
});
