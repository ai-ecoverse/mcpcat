import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attachKernel,
  createNodeKernel,
  fetchReachesKernelLoopback,
  nodeTransport,
} from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const CIMD_URL = 'https://mcpcat.sliccy.ai/oauth/client.json';
const CDP = 'http://127.0.0.1:9311';
const AGENT_DIR = '/home/agent/.pi/agent';
const BROWSER_STATE = '/tmp/fake-browser.json';
const JERK_LOG = '/tmp/fake-jerk.ndjson';
const WORLD = ['login-as', 'playwright-cli', 'jerk', 'login-user', 'login-files'];

async function installPackage(kernel, name, commands, module, data) {
  await kernel.writeFile(`/node_modules/${name}/${module}`, data);
  const entries = commands.map((command) => [command, { abi: 'js', module }]);
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({
      name,
      version: name === '@ai-ecoverse/mcpcat' ? pkg.version : '1.0.0',
      type: 'module',
      slicc: { commands: Object.fromEntries(entries) },
    })
  );
}

describe('mcpcat login in the kernel', () => {
  let kernel;
  let client;
  const servers = [];

  before(async () => {
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: !fetchReachesKernelLoopback }) },
    });
    await installPackage(
      kernel,
      '@ai-ecoverse/mcpcat',
      ['mcpcat'],
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await installPackage(
      kernel,
      '@ai-ecoverse/mcpcat-test-login-world',
      WORLD,
      'dist/world.mjs',
      readFileSync(join(fixturesDir, 'kernel-login-world.mjs'))
    );
    client = await attachKernel(await kernel.connect());
  });

  after(async () => {
    for (const server of servers) {
      const spawned = await server.spawned;
      spawned.signal('SIGTERM');
      await spawned.exited.catch(() => undefined);
    }
    client?.close();
    kernel?.terminate();
  });

  beforeEach(async () => {
    const reset = ['login-files', 'reset', BROWSER_STATE, JERK_LOG];
    const { status, stderr } = await kernel.run(reset, { stdout: 'pipe', stderr: 'pipe' });
    assert.equal(status, 0, stderr);
  });

  async function authServer(seed = {}) {
    const dec = new TextDecoder();
    let stdout = '';
    let log = '';
    let ready;
    const port = new Promise((resolve) => {
      ready = resolve;
    });
    const spawned = client.spawn(['login-as', JSON.stringify(seed)], {
      stdin: 'pipe',
      onStdout(chunk) {
        stdout += dec.decode(chunk, { stream: true });
        const nl = stdout.indexOf('\n');
        if (nl >= 0) ready(JSON.parse(stdout.slice(0, nl)).port);
      },
      onStderr(chunk) {
        log += dec.decode(chunk, { stream: true });
      },
    });
    servers.push({ spawned });
    const url = `http://127.0.0.1:${await port}/mcp`;
    return { url, log: () => log };
  }

  async function login(url, env = {}, extra = []) {
    return kernel.run(['mcpcat', 'login', url, ...extra], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: AGENT_DIR, SLICC_CDP_URL: CDP, ...env },
    });
  }

  async function paste(url, env = {}, extra = []) {
    return kernel.run(['login-user', url, ...extra], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: AGENT_DIR, ...env },
    });
  }

  async function exists(path) {
    const probe = ['login-files', 'exists', path];
    const { status } = await kernel.run(probe, { stdout: 'pipe', stderr: 'pipe' });
    assert.ok(status === 0 || status === 1, `login-files exited ${status}`);
    return status === 0;
  }

  async function jerkGot() {
    return JSON.parse(new TextDecoder().decode(await kernel.readFile(JERK_LOG)));
  }

  async function browser() {
    return JSON.parse(new TextDecoder().decode(await kernel.readFile(BROWSER_STATE)));
  }

  function assertKept(got, url) {
    assert.deepEqual(got.argv, ['jerk', `mcp:url:${url}`, 'import']);
    assert.equal(got.grant.serverUrl, url);
    assert.equal(got.grant.response.token_type, 'Bearer');
    assert.equal(typeof got.grant.response.access_token, 'string');
    assert.equal(typeof got.grant.response.refresh_token, 'string');
    assert.equal(got.grant.oauth.tokenUrl, new URL('/token', url).href);
    assert.equal(got.grant.oauth.scope, 'bb');
    assert.equal(got.grant.oauth.resource, url);
  }

  function assertQuiet({ stdout, stderr }, got) {
    const output = stdout + stderr;
    for (const secret of [got.grant.response.access_token, got.grant.response.refresh_token]) {
      assert.ok(!output.includes(secret), 'a token reached the output');
    }
    assert.ok(!/[?&]code=/.test(output), 'an authorization code reached the output');
    assert.ok(!output.includes('code_verifier'), 'a verifier reached the output');
  }

  it('signs in with the CIMD client in a browser tab and hands the tokens to jerk', async () => {
    const { url, log } = await authServer();
    const result = await login(url);
    assert.equal(result.status, 0, `${result.stderr}\nAS: ${log()}`);
    assert.ok(result.stdout.includes(`Signed in to ${url}`), result.stdout);
    const got = await jerkGot();
    assertKept(got, url);
    assert.equal(got.grant.oauth.clientId, CIMD_URL);
    assertQuiet(result, got);
    assert.ok(log().includes(`authorize client=${CIMD_URL} scope=bb`), log());
    assert.ok(log().includes('token issued'), log());
    const tab = await browser();
    assert.deepEqual(tab.calls.slice(0, 3), ['open', 'goto', 'tab-list']);
    assert.equal(tab.calls.at(-1), 'close');
    assert.equal(tab.closed, true);
  });

  it('registers dynamically when the server offers it', async () => {
    const { url, log } = await authServer({ dcr: true });
    const result = await login(url);
    assert.equal(result.status, 0, `${result.stderr}\nAS: ${log()}`);
    assert.ok(log().includes('registered'), log());
    const got = await jerkGot();
    assertKept(got, url);
    assert.notEqual(got.grant.oauth.clientId, CIMD_URL);
    assertQuiet(result, got);
  });

  it('never leaves a token on the kernel file system', async () => {
    const { url } = await authServer();
    const result = await login(url);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(`${AGENT_DIR}/mcp-auth.json`), false);
  });

  it('accepts the pasted redirect URL with --no-browser', async () => {
    const { url, log } = await authServer();
    const result = await paste(url, {}, ['--no-browser']);
    assert.equal(result.status, 0, `${result.stderr}\nAS: ${log()}`);
    assert.ok(result.stderr.includes('Paste the redirect URL'), result.stderr);
    assert.equal(await exists(BROWSER_STATE), false);
    assertKept(await jerkGot(), url);
  });

  it('accepts the pasted redirect URL without SLICC_CDP_URL', async () => {
    const { url } = await authServer();
    const result = await paste(url, { SLICC_CDP_URL: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(BROWSER_STATE), false);
    assertKept(await jerkGot(), url);
  });

  it('falls back to the pasted URL when the tab is refused', async () => {
    const { url } = await authServer();
    const result = await paste(url, { SLICC_CDP_URL: CDP, FAKE_BROWSER: 'refuse' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await browser()).calls, ['open']);
    assertKept(await jerkGot(), url);
  });

  for (const [name, mode] of [
    ['state', 'wrong-state'],
    ['iss', 'wrong-iss'],
  ]) {
    it(`refuses a redirect with the wrong ${name} from the tab`, async () => {
      const { url, log } = await authServer();
      const result = await login(url, { FAKE_BROWSER: mode });
      assert.equal(result.status, 4, result.stderr);
      assert.ok(result.stderr.includes('login failed'), result.stderr);
      assert.ok(!log().includes('token'), log());
      assert.equal(await exists(JERK_LOG), false);
      assert.equal((await browser()).closed, true);
    });

    it(`refuses a pasted redirect with the wrong ${name}`, async () => {
      const { url, log } = await authServer();
      const result = await paste(url, { FAKE_USER: mode }, ['--no-browser']);
      assert.equal(result.status, 4, result.stderr);
      assert.ok(result.stderr.includes('login failed'), result.stderr);
      assert.ok(!log().includes('token'), log());
      assert.equal(await exists(JERK_LOG), false);
    });
  }

  it('reports a denied sign-in and exchanges nothing', async () => {
    const { url, log } = await authServer();
    const result = await login(url, { FAKE_BROWSER: 'denied' });
    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes('the user said no'), result.stderr);
    assert.ok(!log().includes('token'), log());
  });

  it('counts a closed tab as a cancelled sign-in', async () => {
    const { url } = await authServer();
    const result = await login(url, { FAKE_BROWSER: 'closed' });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes('sign-in cancelled'), result.stderr);
    assert.equal(await exists(JERK_LOG), false);
  });

  it('gives up when the browser stops answering', async () => {
    const { url } = await authServer();
    const result = await login(url, { FAKE_BROWSER: 'blind' });
    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes('lost the browser'), result.stderr);
  });

  it('opens nothing when jerk cannot keep the token', async () => {
    const { url, log } = await authServer();
    const result = await login(url, { FAKE_JERK: 'old' });
    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes('not available in seven with this jerk'), result.stderr);
    assert.equal(await exists(BROWSER_STATE), false);
    assert.equal(log(), '');
  });

  it("exits 4 with jerk's reason when it refuses the tokens", async () => {
    const { url } = await authServer();
    const result = await login(url, { FAKE_JERK: 'locked' });
    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes("seven's vault is locked"), result.stderr);
    assert.equal(await exists(`${AGENT_DIR}/mcp-auth.json`), false);
  });

  it('keeps a failing token endpoint out of the output', async () => {
    const { url } = await authServer({ tokenFailure: true });
    const result = await login(url);
    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes('login failed: HTTP 500'), result.stderr);
    assert.ok(!result.stderr.includes('code_verifier'), result.stderr);
    assert.ok(!/code=/.test(result.stderr), result.stderr);
  });
});
