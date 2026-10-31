import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { kernelAtLeast } from './helpers/kernel.mjs';
import {
  AGENT_DIR,
  assertNoValue,
  bootKernel,
  CONFIG,
  gatedServer,
  jerkAnswers,
  jerkLog,
  listed,
  mcpcat,
  sealedExit,
} from './helpers/sealed-exit.mjs';

const VAULT_DIR = process.env.MCPCAT_VAULT_DIR;
const chrome = VAULT_DIR
  ? await (await import(join(VAULT_DIR, 'test/integration/setup.mjs'))).setup()
  : undefined;
const OAUTH = `fnox_proxy_${'a1'.repeat(12)}`;
const HEADER = `fnox_proxy_${'b2'.repeat(12)}`;
const UNFILLED = `fnox_proxy_${'c3'.repeat(12)}`;
const STALE = `fnox_proxy_${'d4'.repeat(12)}`;
const SETTINGS = 'Sign in under Settings › MCP servers';
const NOT_ACCEPTED =
  "The request carried the signed-in credential's placeholder and the server still answered 401. Seven's vault fills the placeholder in when the request is forwarded, so either that forwarding is not active in this seven yet or the server rejected the credential. Try again from the Settings page's Connect, or ask whoever runs seven.";
const REJECTED = 'The server rejected the explicit Authorization header';
const SERVERS = {
  bb: { url: 'https://bb.example.com/mcp' },
  modern: { url: 'https://modern.example.com/modern/mcp' },
  hdr: {
    url: 'https://hdr.example.com/hdr',
    headers: { Authorization: 'Bearer ${MCP_HDR_TOKEN}' },
  },
  open: { url: 'https://open.example.com/open' },
};
const ALL = listed('bb', 'modern', 'hdr', 'open');
const CREDENTIAL = { value: 'real-credential-537' };
const VALUES = {
  [OAUTH]: CREDENTIAL.value,
  [HEADER]: CREDENTIAL.value,
  [STALE]: 'stale-credential-537',
};

function standInVault(head, body) {
  const headers = head.headers.map(([name, value]) => [
    name,
    value.replace(/fnox_proxy_[0-9a-f]{24}/g, (p) => VALUES[p] ?? p),
  ]);
  return { head: { ...head, headers }, body };
}

const sent = (offered, url) =>
  offered
    .filter((o) => o.url.startsWith(url))
    .map((o) => o.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1]);

describe('kernel: credentials go out as placeholders', () => {
  let upstream;
  let exit;
  let kernel;
  let run;

  before(async () => {
    upstream = await gatedServer(CREDENTIAL);
    exit = sealedExit(upstream.port, standInVault);
    kernel = await bootKernel(exit.transport, SERVERS);
    run = mcpcat(kernel, { MCP_HDR_TOKEN: HEADER });
  });

  after(() => {
    kernel?.terminate();
    upstream?.close();
  });

  const reset = async (get, list = ALL) => {
    await jerkAnswers(kernel, get, list);
    exit.offered.length = 0;
    upstream.seen.length = 0;
  };

  for (const [verb, ...args] of [
    ['info'],
    ['tools'],
    ['call', '{target}', 'whoami'],
    ['grep', 'whoami'],
    ['describe', '{target}', '--ts'],
  ]) {
    const argv = (target) => {
      const filled = args.map((a) => (a === '{target}' ? target : a));
      return args.includes('{target}') ? [verb, ...filled] : [verb, target, ...filled];
    };

    it(`${verb}: an OAuth entry sends the placeholder from jerk and mcpcat sees no value`, async () => {
      await reset({
        'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` },
        'mcp:modern': { exit: 0, stdout: `${OAUTH}\n` },
      });
      const { status, stdout, stderr } = await run(...argv('bb'));
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        [...new Set(sent(exit.offered, 'https://bb.example.com'))],
        [`Bearer ${OAUTH}`]
      );
      assert.ok(
        upstream.seen
          .filter((s) => !s.url.startsWith('/open'))
          .every((s) => s.authorization === `Bearer ${CREDENTIAL.value}`)
      );
      assertNoValue(CREDENTIAL.value, stdout, stderr);
    });

    it(`${verb}: a \${NAME} header entry sends the placeholder and never asks jerk`, async () => {
      await reset({ 'mcp:hdr': { exit: 0, stdout: `${OAUTH}\n` } });
      const { status, stdout, stderr } = await run(...argv('hdr'));
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        [...new Set(sent(exit.offered, 'https://hdr.example.com'))],
        [`Bearer ${HEADER}`]
      );
      assert.ok(!(await jerkLog(kernel)).some((line) => line.startsWith('mcp:hdr get')));
      assertNoValue(CREDENTIAL.value, stdout, stderr);
    });
  }

  it('asks jerk once per request, caches nothing and writes nothing to mcp.json', async () => {
    const before = await kernel.readFile(CONFIG);
    await reset({ 'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` } });
    assert.equal((await run('tools', 'bb')).status, 0);
    const gets = (await jerkLog(kernel)).filter((line) => line.startsWith('mcp:bb get'));
    const offered = sent(exit.offered, 'https://bb.example.com').length;
    assert.ok(offered > 1);
    assert.ok(gets.length === offered || gets.length === offered + 1, gets.join('\n'));
    assert.ok(gets.every((line) => line.endsWith(`config=${CONFIG}`)));
    assert.ok(!gets.some((line) => line.includes('--reveal')));
    assert.deepEqual(await kernel.readFile(CONFIG), before);
  });

  it('a modern server takes the placeholder the same way', async () => {
    await reset({ 'mcp:modern': { exit: 0, stdout: `${OAUTH}\n` } });
    const { status, stderr } = await run('tools', 'modern');
    assert.equal(status, 0, stderr);
    assert.ok(upstream.seen.every((s) => s.authorization === `Bearer ${CREDENTIAL.value}`));
    const gets = (await jerkLog(kernel)).filter((line) => line.startsWith('mcp:modern get'));
    assert.equal(gets.length, sent(exit.offered, 'https://modern.example.com').length);
  });

  it('refuses with exit 4 what does not look like a placeholder, and never prints it', async () => {
    const token = 'gho_notAPlaceholder537';
    await reset({ 'mcp:bb': { exit: 0, stdout: `${token}\n` } });
    const { status, stdout, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.match(stderr, /did not give a placeholder/);
    assertNoValue(token, stdout, stderr);
    assert.equal(exit.offered.length, 0);
  });

  const assertNotAccepted = (status, stderr) => {
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(NOT_ACCEPTED), stderr);
    assert.ok(!stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
    assert.ok(!stderr.includes('fnox_proxy_'), stderr);
    assert.equal(upstream.seen.length, 1);
  };

  for (const target of ['bb', 'modern']) {
    it(`${target}: an unfilled placeholder that gets a 401 is reported as such, without a retry`, async () => {
      await reset({ [`mcp:${target}`]: { exit: 0, stdout: `${UNFILLED}\n` } });
      const { status, stderr } = await run('info', target);
      assertNotAccepted(status, stderr);
    });

    it(`${target}: a filled credential the server rejects gets the same report`, async () => {
      await reset({ [`mcp:${target}`]: { exit: 0, stdout: `${STALE}\n` } });
      const { status, stderr } = await run('info', target);
      assertNotAccepted(status, stderr);
      assert.ok(!stderr.includes(VALUES[STALE]), stderr);
    });
  }

  it('on a pinned legacy protocol a placeholder that gets a 401 is reported as such', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${UNFILLED}\n` } });
    const { status, stderr } = await run('--protocol-version', '2025-11-25', 'info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(NOT_ACCEPTED), stderr);
    assert.ok(!stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
  });

  it('a 401 with no placeholder keeps the sign-in pointer', async () => {
    await reset({});
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes(NOT_ACCEPTED), stderr);
  });

  it('a 403 after a placeholder keeps the Settings pointer', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${UNFILLED}\n` } });
    upstream.status = 403;
    const { status, stderr } = await run('info', 'bb');
    upstream.status = 401;
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes(NOT_ACCEPTED), stderr);
  });

  it('with no placeholder from jerk the request goes out bare and a public server works', async () => {
    await reset({});
    const { status, stderr } = await run('tools', 'open');
    assert.equal(status, 0, stderr);
    assert.deepEqual([...new Set(sent(exit.offered, 'https://open.example.com'))], [undefined]);
  });

  it('a -H Authorization wins and jerk is not asked for it', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` } });
    const { status, stderr } = await run(
      '-H',
      'Authorization: Bearer ${MCP_HDR_TOKEN}',
      'info',
      'bb'
    );
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      [...new Set(sent(exit.offered, 'https://bb.example.com'))],
      [`Bearer ${HEADER}`]
    );
    assert.ok(!(await jerkLog(kernel)).some((line) => line.includes(' get')));
  });

  it('a name jerk lists from elsewhere is not asked for', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` } }, [
      { provider: 'mcp:bb', name: 'bb', source: 'host:laptop' },
    ]);
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
    assert.ok(!(await jerkLog(kernel)).some((line) => line.includes(' get')));
  });

  it('a URL target uses the mcp:url: id', async () => {
    const id = 'mcp:url:https://bb.example.com/mcp';
    await reset({ [id]: { exit: 0, stdout: `${OAUTH}\n` } });
    const { status, stderr } = await run('info', 'https://bb.example.com/mcp');
    assert.equal(status, 0, stderr);
    assert.ok((await jerkLog(kernel)).some((line) => line.startsWith(`${id} get`)));
  });

  it('serve --proxy sends the placeholder upstream', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` } });
    const proxy = mcpcat(
      kernel,
      {},
      {
        stdin: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
      }
    );
    const out = await proxy('serve', '--proxy', 'bb', '--stdio');
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes('whoami'), out.stdout);
    assert.deepEqual(
      [...new Set(sent(exit.offered, 'https://bb.example.com'))],
      [`Bearer ${OAUTH}`]
    );
    assertNoValue(CREDENTIAL.value, out.stdout, out.stderr);
  });
});

describe('kernel: a non-root user gets no placeholder', {
  skip: !kernelAtLeast(86) && 'ctx.sync.cred and kernel.chmod need slicc-kernel >= 1.86.0',
}, () => {
  const AS_CONE = { user: 'cone' };
  const NATIVE_TOOLS = "the agent already has this server's tools";
  const PANEL_ROOT = 'a human can use the server from a panel terminal as root';
  const NOT_SIGNED_IN = {
    exit: 3,
    stderr:
      'jerk: mcp:bb: not signed in\n' +
      'jerk: mcp:bb: sign-in happens in Settings › MCP servers, where it is sealed\n',
  };
  const REFUSED = { exit: 1, stderr: 'jerk: mcp:bb: refused\n' };
  let upstream;
  let exit;
  let kernel;

  before(async () => {
    upstream = await gatedServer(CREDENTIAL);
    exit = sealedExit(upstream.port, standInVault);
    kernel = await bootKernel(exit.transport, SERVERS, { users: 'enforce' });
    await kernel.users.add({ name: 'cone', umask: 0o022 });
    await kernel.chmod(AGENT_DIR, 0o777);
    await kernel.chmod(CONFIG, 0o644);
  });

  after(() => {
    kernel?.terminate();
    upstream?.close();
  });

  const reset = async (get, list = ALL) => {
    await jerkAnswers(kernel, get, list);
    await kernel.chmod('/etc/fake-jerk.json', 0o644);
    exit.offered.length = 0;
    upstream.seen.length = 0;
    upstream.status = 401;
    upstream.headers = {};
  };

  for (const [why, answer] of [
    ['says no record', NOT_SIGNED_IN],
    ['refuses', REFUSED],
  ]) {
    for (const target of ['bb', 'modern']) {
      it(`${target}: when jerk ${why}, a 401 exits 4 and says where the server can be used`, async () => {
        await reset({ [`mcp:${target}`]: answer });
        const { status, stdout, stderr } = await mcpcat(kernel, {}, AS_CONE)('info', target);
        assert.equal(status, 4, stderr);
        assert.ok(stderr.includes(NATIVE_TOOLS), stderr);
        assert.ok(stderr.includes(PANEL_ROOT), stderr);
        assert.ok(stderr.includes(SETTINGS), stderr);
        assert.ok(!stderr.includes('mcpcat login'), stderr);
        assert.equal(upstream.seen.length, 1);
        assert.ok(upstream.seen.every((s) => s.authorization === undefined));
        assert.ok((await jerkLog(kernel)).some((line) => line.startsWith(`mcp:${target} get`)));
        assertNoValue(CREDENTIAL.value, stdout, stderr);
      });
    }
  }

  for (const target of ['bb', 'modern']) {
    it(`${target}: a 403 scope challenge still names the required scope`, async () => {
      await reset({ [`mcp:${target}`]: NOT_SIGNED_IN });
      upstream.status = 403;
      upstream.headers = {
        'www-authenticate': 'Bearer error="insufficient_scope", scope="admin"',
      };
      const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)('info', target);
      assert.equal(status, 4, stderr);
      assert.match(stderr, /insufficient scope \(required: admin\)/);
      assert.ok(stderr.includes(SETTINGS), stderr);
      assert.ok(!stderr.includes('mcpcat login'), stderr);
      assert.ok(!stderr.includes(NATIVE_TOOLS), stderr);
    });

    it(`${target}: a 403 with no scope challenge points to Settings`, async () => {
      await reset({ [`mcp:${target}`]: NOT_SIGNED_IN });
      upstream.status = 403;
      const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)('info', target);
      assert.equal(status, 4, stderr);
      assert.ok(stderr.includes(SETTINGS), stderr);
      assert.ok(!stderr.includes('mcpcat login'), stderr);
    });

    it(`${target}: a rejected explicit Authorization header is named as the cause`, async () => {
      await reset({});
      const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)(
        '-H',
        'Authorization: Bearer wrong-value',
        'info',
        target
      );
      assert.equal(status, 4, stderr);
      assert.ok(stderr.includes(REJECTED), stderr);
      assert.ok(!stderr.includes('mcpcat login'), stderr);
      assert.ok(!stderr.includes(SETTINGS), stderr);
      assertNoValue('wrong-value', stderr);
    });
  }

  it('on a pinned legacy protocol a 401 points to Settings', async () => {
    await reset({ 'mcp:bb': NOT_SIGNED_IN });
    const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)(
      '--protocol-version',
      '2025-11-25',
      'info',
      'bb'
    );
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
  });

  it('on a pinned legacy protocol a rejected header is named as the cause', async () => {
    await reset({});
    const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)(
      '--protocol-version',
      '2025-11-25',
      '-H',
      'Authorization: Bearer wrong-value',
      'info',
      'bb'
    );
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(REJECTED), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
  });

  it('a target jerk does not list points to Settings and blames no one', async () => {
    await reset({}, listed('modern'));
    const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes('gets no placeholder'), stderr);
    assert.ok(!stderr.includes(NATIVE_TOOLS), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
    assert.ok(!(await jerkLog(kernel)).some((line) => line.includes(' get')));
  });

  it('grep names the same places for a target it cannot reach', async () => {
    await reset({ 'mcp:bb': NOT_SIGNED_IN });
    const { stderr } = await mcpcat(kernel, {}, AS_CONE)('grep', 'whoami');
    assert.ok(stderr.includes(NATIVE_TOOLS), stderr);
    assert.ok(stderr.includes(PANEL_ROOT), stderr);
  });

  it('a public server still works with no placeholder', async () => {
    await reset({});
    const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)('tools', 'open');
    assert.equal(status, 0, stderr);
  });

  it('a placeholder from jerk goes out for a non-root user too', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` } });
    const { status, stderr } = await mcpcat(kernel, {}, AS_CONE)('tools', 'bb');
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      [...new Set(sent(exit.offered, 'https://bb.example.com'))],
      [`Bearer ${OAUTH}`]
    );
  });

  it('root sends the placeholder as before', async () => {
    await reset({ 'mcp:bb': { exit: 0, stdout: `${OAUTH}\n` } });
    const { status, stderr } = await mcpcat(kernel, {})('tools', 'bb');
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      [...new Set(sent(exit.offered, 'https://bb.example.com'))],
      [`Bearer ${OAUTH}`]
    );
  });

  for (const target of ['bb', 'modern']) {
    it(`${target}: root without a placeholder is sent to Settings, not to mcpcat login`, async () => {
      await reset({ [`mcp:${target}`]: NOT_SIGNED_IN });
      const { status, stderr } = await mcpcat(kernel, {})('info', target);
      assert.equal(status, 4, stderr);
      assert.ok(stderr.includes(SETTINGS), stderr);
      assert.ok(!stderr.includes('mcpcat login'), stderr);
      assert.ok(!stderr.includes(NATIVE_TOOLS), stderr);
      assert.equal(upstream.seen.length, 1);
    });
  }

  it('root: a 403 scope challenge still names the required scope', async () => {
    await reset({ 'mcp:bb': NOT_SIGNED_IN });
    upstream.status = 403;
    upstream.headers = { 'www-authenticate': 'Bearer error="insufficient_scope", scope="admin"' };
    const { status, stderr } = await mcpcat(kernel, {})('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.match(stderr, /required: admin/);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
  });
});

describe('kernel: a Settings sign-in through the real vault', {
  skip: !VAULT_DIR && 'set MCPCAT_VAULT_DIR to a built slicc-vault checkout',
}, () => {
  const TOKEN = 'fake-bb-access-5372';
  const OWNER = { pid: 9, ppid: 1, uid: 1000, gid: 1000, tag: 'cone', users: 'enforce' };
  const URL_BB = 'https://bb.example.com/mcp';

  async function signedIn(t) {
    const page = await chrome.embedder(t);
    await page.evaluate(() => window.harness.connect());
    await page.evaluate(() => window.harness.agent());
    const ask = (op, fields) => page.evaluate((o, f) => window.harness.ask(o, f), op, fields);
    const tokenUrl = 'https://auth.example.com/token';
    await ask('endpoints', { mcp: [{ server: 'bb', url: URL_BB, tokenUrl, names: [] }] });
    const granted = await ask('grant', {
      server: 'bb',
      oauth: { tokenUrl, clientId: 'fake-client' },
      response: JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 }),
    });
    const fill = (head, body) =>
      page.evaluate(
        async (fields) => {
          const { reply } = await window.harness.forward(fields);
          const text = reply.body ? new TextDecoder().decode(reply.body) : undefined;
          return { head: reply.head, refused: reply.refused, body: text };
        },
        { head, body, owner: OWNER, exit: 'page', rawTraits: {} }
      );
    return { placeholder: granted.records[0].placeholder, fill };
  }

  it('fills the credential on a kernel request that carries only the placeholder', async (t) => {
    const { placeholder, fill } = await signedIn(t);
    const upstream = await gatedServer({ value: TOKEN });
    t.after(() => upstream.close());
    const exit = sealedExit(upstream.port, fill);
    const kernel = await bootKernel(exit.transport, { bb: { url: URL_BB } });
    t.after(() => kernel.terminate());
    await jerkAnswers(kernel, { 'mcp:bb': { exit: 0, stdout: `${placeholder}\n` } }, listed('bb'));
    const { status, stdout, stderr } = await mcpcat(kernel, {})('tools', 'bb');
    assert.equal(status, 0, stderr);
    assert.ok(stdout.includes('whoami'), stdout);
    assert.deepEqual([...new Set(sent(exit.offered, URL_BB))], [`Bearer ${placeholder}`]);
    assert.ok(upstream.seen.length > 0);
    assert.ok(upstream.seen.every((s) => s.authorization === `Bearer ${TOKEN}`));
    assertNoValue(TOKEN, stdout, stderr, JSON.stringify(exit.offered));
  });

  it('NEGATIVE the placeholder aimed at another URL is refused and exits 4', async (t) => {
    const { placeholder, fill } = await signedIn(t);
    const upstream = await gatedServer({ value: TOKEN });
    t.after(() => upstream.close());
    const exit = sealedExit(upstream.port, fill);
    const kernel = await bootKernel(exit.transport, {
      bb: { url: 'https://evil.example.com/mcp' },
    });
    t.after(() => kernel.terminate());
    await jerkAnswers(kernel, { 'mcp:bb': { exit: 0, stdout: `${placeholder}\n` } }, listed('bb'));
    const { status, stdout, stderr } = await mcpcat(kernel, {})('tools', 'bb');
    assert.equal(status, 4, stderr);
    assert.equal(upstream.seen.length, 0);
    assertNoValue(TOKEN, stdout, stderr);
  });

  it('a request without the placeholder never reaches the vault and gets the 401', async (t) => {
    const { fill } = await signedIn(t);
    const upstream = await gatedServer({ value: TOKEN });
    t.after(() => upstream.close());
    const exit = sealedExit(upstream.port, fill);
    const kernel = await bootKernel(exit.transport, { bb: { url: URL_BB } });
    t.after(() => kernel.terminate());
    await jerkAnswers(kernel, {}, listed('bb'));
    const { status } = await mcpcat(kernel, {})('tools', 'bb');
    assert.equal(status, 4);
    assert.ok(upstream.seen.every((s) => s.authorization === undefined));
  });
});
