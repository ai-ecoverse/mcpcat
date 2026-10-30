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
const SERVERS = { bb: { url: 'https://bb.example.com/mcp' } };

describe('kernel: a non-root user with an unwritable config directory', () => {
  const AS_CONE = { user: 'cone' };
  let upstream;
  let kernel;
  let cone;

  before(async () => {
    upstream = await gatedServer({ value: 'unused' });
    const exit = sealedExit(upstream.port, (head, body) => ({ head, body }));
    kernel = await bootKernel(exit.transport, SERVERS, { users: 'enforce' });
    await kernel.users.add({ name: 'cone', umask: 0o022 });
    await kernel.chmod(AGENT_DIR, 0o755);
    await kernel.chmod(CONFIG, 0o644);
    await jerkAnswers(kernel, {}, listed('bb'));
    await kernel.chmod('/etc/fake-jerk.json', 0o644);
    await kernel.chmod('/tmp/fake-jerk.log', 0o666);
    cone = mcpcat(kernel, {}, AS_CONE);
  });

  after(() => {
    kernel?.terminate();
    upstream?.close();
  });

  for (const [verb, target] of [
    ['info', 'bb'],
    ['tools', 'https://bb.example.com/mcp'],
  ]) {
    it(`${verb} ${target} exits 2 and names the path`, async () => {
      upstream.seen.length = 0;
      const { status, stderr } = await cone(verb, target);
      assert.equal(status, 2, stderr);
      assert.ok(stderr.includes(TOKEN_LOCK), stderr);
      assert.ok(!stderr.includes('command not found'), stderr);
      assert.equal(upstream.seen.length, 0);
    });
  }

  it('--json reports the path too', async () => {
    const { status, stderr } = await cone('--json', 'info', 'bb');
    assert.equal(status, 2, stderr);
    const { error } = JSON.parse(stderr);
    assert.ok(error.message.includes(TOKEN_LOCK), stderr);
    assert.notEqual(error.kind, 'connection');
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
