import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  AGENT_DIR,
  bootKernel,
  CONFIG,
  gatedServer,
  jerkAnswers,
  listed,
  mcpcat,
  sealedExit,
} from './helpers/sealed-exit.mjs';

const TOKEN_LOCK = `${AGENT_DIR}/mcp-auth.json.lock`;
const CONFIG_LOCK = `${CONFIG}.lock`;
const TOKENS = `${AGENT_DIR}/mcp-auth.json`;
const SETTINGS = 'Sign in under Settings › MCP servers';
const SERVERS = {
  bb: { url: 'https://bb.example.com/mcp' },
  open: { url: 'https://open.example.com/open' },
};
const LEGACY_STORE = JSON.stringify({
  'https://bb.example.com/mcp': {
    serverUrl: 'https://bb.example.com/mcp',
    tokens: { access_token: 'stored', token_type: 'Bearer' },
  },
});

describe('kernel: a non-root user with an unwritable config directory', () => {
  const AS_CONE = { user: 'cone' };
  let upstream;
  let kernel;
  let cone;

  before(async () => {
    upstream = await gatedServer({ value: 'stored' });
    const exit = sealedExit(upstream.port, (head, body) => ({ head, body }));
    kernel = await bootKernel(exit.transport, SERVERS, { users: 'enforce' });
    await kernel.users.add({ name: 'cone', umask: 0o022 });
    await kernel.chmod(AGENT_DIR, 0o755);
    await kernel.chmod(CONFIG, 0o644);
    await jerkAnswers(kernel, {}, listed('bb', 'open'));
    await kernel.chmod('/etc/fake-jerk.json', 0o644);
    await kernel.chmod('/tmp/fake-jerk.log', 0o666);
    cone = mcpcat(kernel, {}, AS_CONE);
  });

  after(() => {
    kernel?.terminate();
    upstream?.close();
  });

  for (const argv of [
    ['info', 'open'],
    ['tools', 'open'],
    ['call', 'open', 'whoami'],
    ['tools', 'https://open.example.com/open'],
  ]) {
    it(`${argv.join(' ')} reaches a public server`, async () => {
      upstream.seen.length = 0;
      const { status, stderr } = await cone(...argv);
      assert.equal(status, 0, stderr);
      assert.ok(upstream.seen.length > 0);
      await assert.rejects(kernel.readFile(TOKEN_LOCK));
    });
  }

  for (const target of ['bb', 'https://bb.example.com/mcp']) {
    it(`info ${target} gets to the 401 and exits 4`, async () => {
      upstream.seen.length = 0;
      const { status, stderr } = await cone('info', target);
      assert.equal(status, 4, stderr);
      assert.ok(stderr.includes(SETTINGS), stderr);
      assert.ok(!stderr.includes('could not write'), stderr);
      assert.equal(upstream.seen.length, 1);
    });
  }

  it('--json reports the 401 as an auth failure', async () => {
    const { status, stderr } = await cone('--json', 'info', 'bb');
    assert.equal(status, 4, stderr);
    assert.equal(JSON.parse(stderr).error.kind, 'auth');
  });

  it('a 403 on a pinned legacy protocol exits 4, not could-not-write', async () => {
    upstream.status = 403;
    const { status, stderr } = await cone('--protocol-version', '2025-11-25', 'info', 'bb');
    upstream.status = 401;
    assert.equal(status, 4, stderr);
    assert.ok(!stderr.includes('could not write'), stderr);
  });

  it('a token store it can read still works, and stays as it is', async () => {
    await kernel.writeFile(TOKENS, LEGACY_STORE);
    await kernel.chmod(TOKENS, 0o644);
    upstream.seen.length = 0;
    const { status, stderr } = await cone('tools', 'bb');
    assert.equal(status, 0, stderr);
    assert.ok(upstream.seen.every((s) => s.authorization === 'Bearer stored'));
    assert.equal(new TextDecoder().decode(await kernel.readFile(TOKENS)), LEGACY_STORE);
  });

  it('a token store it cannot read counts as empty', async () => {
    await kernel.chmod(TOKENS, 0o600);
    const open = await cone('tools', 'open');
    assert.equal(open.status, 0, open.stderr);
    const gated = await cone('info', 'bb');
    assert.equal(gated.status, 4, gated.stderr);
    assert.ok(gated.stderr.includes(SETTINGS), gated.stderr);
  });

  for (const argv of [
    ['add', 'x', 'https://x.example.com/mcp'],
    ['rm', 'bb'],
  ]) {
    it(`${argv[0]} exits 2, names the path and leaves mcp.json alone`, async () => {
      const before = await kernel.readFile(CONFIG);
      const { status, stderr } = await cone(...argv);
      assert.equal(status, 2, stderr);
      assert.ok(stderr.includes(CONFIG_LOCK), stderr);
      assert.ok(!stderr.includes('command not found'), stderr);
      assert.deepEqual(await kernel.readFile(CONFIG), before);
    });
  }

  it('a stdio target that does not exist still says command not found', async () => {
    await kernel.writeFile(
      CONFIG,
      JSON.stringify({ mcpServers: { gone: { command: 'no-such-server' } } })
    );
    await kernel.chmod(CONFIG, 0o644);
    const { status, stderr } = await cone('info', 'gone');
    assert.equal(status, 3, stderr);
    assert.ok(stderr.includes('no-such-server'), stderr);
  });
});
