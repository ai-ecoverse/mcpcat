import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
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
  standInVault,
} from './helpers/sealed-exit.mjs';

const VAULT = `fnox_proxy_${'e5'.repeat(12)}`;
const JERK = `fnox_proxy_${'f6'.repeat(12)}`;
const SETTINGS = 'Sign in under Settings › MCP servers';
const NOT_ACCEPTED = "The request carried the signed-in credential's placeholder";
const NO_ANSWER = "Seven's vault did not answer, so the request carried no credential";
const NATIVE_TOOLS = "the agent already has this server's tools";
const PANEL_ROOT = 'a human can use the server from a panel terminal as root';
const SERVERS = {
  bb: { url: 'https://bb.example.com/mcp' },
  hdr: {
    url: 'https://hdr.example.com/hdr',
    headers: { Authorization: 'Bearer ${MCP_HDR_TOKEN}' },
  },
  open: { url: 'https://open.example.com/open' },
};
const CREDENTIAL = { value: 'real-credential-537' };
const AS_CONE = { user: 'cone' };
const GET = {
  'mcp:bb': { exit: 0, stdout: `${JERK}\n` },
  'mcp:open': { exit: 0, stdout: `${JERK}\n` },
};
const LISTED = listed('bb', 'hdr', 'open');

const mcpRecord = () => ({ placeholder: VAULT, state: 'active', kind: 'mcp' });
const refused = (code, message) => () => ({ error: { code, message } });

function filled(head, body) {
  const headers = head.headers.map(([name, value]) => [
    name,
    value.replace(VAULT, CREDENTIAL.value).replace(JERK, CREDENTIAL.value),
  ]);
  return { head: { ...head, headers }, body };
}

const passthrough = (head, body) => ({ head, body });

const sent = (offered, url) =>
  offered
    .filter((o) => o.url.startsWith(url))
    .map((o) => o.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1]);

async function bench({ jerk, fill = filled, hook = true }) {
  const upstream = await gatedServer(CREDENTIAL);
  const exit = sealedExit(upstream.port, fill);
  const vault = standInVault(mcpRecord);
  const kernel = await bootKernel(exit.transport, SERVERS, {
    jerk,
    users: 'enforce',
    ...(hook ? { sealed: vault.sealed } : {}),
  });
  await kernel.users.add({ name: 'cone', umask: 0o022 });
  const reset = async (answer = mcpRecord) => {
    await kernel.chmod(AGENT_DIR, 0o777);
    await kernel.chmod(CONFIG, 0o644);
    vault.answer = answer;
    vault.requests.length = 0;
    exit.offered.length = 0;
    upstream.seen.length = 0;
    upstream.status = 401;
    upstream.headers = {};
    if (jerk) {
      await jerkAnswers(kernel, GET, LISTED);
      await kernel.chmod('/etc/fake-jerk.json', 0o644);
    }
  };
  const close = () => {
    kernel.terminate();
    upstream.close();
  };
  return { upstream, exit, vault, kernel, reset, close };
}

describe('kernel: root asks the vault, jerk optional', {
  skip: !kernelAtLeast(86) && 'ctx.sync.cred and kernel.chmod need slicc-kernel >= 1.86.0',
}, () => {
  let bed;
  let run;

  before(async () => {
    bed = await bench({ jerk: false });
    run = mcpcat(bed.kernel, { MCP_HDR_TOKEN: `fnox_proxy_${'ab'.repeat(12)}` });
  });
  beforeEach(() => bed.reset());
  after(() => bed?.close());

  it('sends the vault placeholder with no jerk installed, and the server is reached', async () => {
    const { status, stdout, stderr } = await run('tools', 'bb');
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      [...new Set(sent(bed.exit.offered, 'https://bb.example.com'))],
      [`Bearer ${VAULT}`]
    );
    assert.ok(bed.upstream.seen.every((s) => s.authorization === `Bearer ${CREDENTIAL.value}`));
    assertNoValue(CREDENTIAL.value, stdout, stderr);
    assertNoValue(VAULT, stdout, stderr);
  });

  it('asks with the server alone, under the root stamp', async () => {
    assert.equal((await run('info', 'bb')).status, 0);
    const { caller, ...request } = bed.vault.requests[0];
    assert.deepEqual(request, { v: 1, op: 'placeholder', server: 'bb' });
    assert.equal(caller.uid, 0);
  });

  it('asks once per request, caches nothing and writes nothing to mcp.json', async () => {
    const config = await bed.kernel.readFile(CONFIG);
    assert.equal((await run('tools', 'bb')).status, 0);
    const offered = sent(bed.exit.offered, 'https://bb.example.com').length;
    const asked = bed.vault.requests.length;
    assert.ok(offered > 1);
    assert.ok(asked === offered || asked === offered + 1, `${asked} for ${offered}`);
    assert.deepEqual(await bed.kernel.readFile(CONFIG), config);
  });

  it('an Authorization header entry never asks the vault', async () => {
    await run('info', 'hdr');
    assert.equal(bed.vault.requests.length, 0);
  });

  it('a URL target names no server and never asks the vault', async () => {
    await run('info', 'https://bb.example.com/mcp');
    assert.equal(bed.vault.requests.length, 0);
  });

  it('with no jerk, an unavailable vault leaves the request bare and points to Settings', async () => {
    await bed.reset(refused('ENOTCONN', 'no vault'));
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.deepEqual(sent(bed.exit.offered, 'https://bb.example.com'), [undefined]);
  });

  for (const [what, reply] of [
    ['a kind other than mcp', { placeholder: VAULT, state: 'active', kind: 'secret' }],
    ['no kind', { placeholder: VAULT, state: 'active' }],
    ['a value in place of the placeholder', { placeholder: 'gho_value537', kind: 'mcp' }],
    ['no placeholder', { state: 'active', kind: 'mcp' }],
    ['a placeholder in a list', { placeholder: [VAULT], kind: 'mcp' }],
  ]) {
    it(`refuses ${what} with exit 4, sending and printing nothing`, async () => {
      await bed.reset(() => reply);
      const { status, stdout, stderr } = await run('info', 'bb');
      assert.equal(status, 4, stderr);
      assert.match(stderr, /did not give a placeholder/);
      assertNoValue(VAULT, stdout, stderr);
      assertNoValue('gho_value537', stdout, stderr);
      assert.equal(sent(bed.exit.offered, 'https://bb.example.com').length, 0);
    });
  }

  it('an unfilled vault placeholder that gets a 401 is reported as such, without a retry', async () => {
    await bed.close();
    bed = await bench({ jerk: false, fill: passthrough });
    run = mcpcat(bed.kernel, {});
    await bed.reset();
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(NOT_ACCEPTED), stderr);
    assert.ok(!stderr.includes(SETTINGS), stderr);
    assertNoValue(VAULT, stderr);
    assert.equal(bed.upstream.seen.length, 1);
  });
});

describe('kernel: what the vault answers decides whether jerk is asked', {
  skip: !kernelAtLeast(86) && 'ctx.sync.cred and kernel.chmod need slicc-kernel >= 1.86.0',
}, () => {
  let bed;
  let run;
  const jerkGets = async () =>
    (await jerkLog(bed.kernel)).filter((line) => line.startsWith('mcp:bb get'));

  before(async () => {
    bed = await bench({ jerk: true });
    run = mcpcat(bed.kernel, {});
  });
  beforeEach(() => bed.reset());
  after(() => bed?.close());

  it('a vault placeholder wins and jerk does not run at all', async () => {
    const { status, stderr } = await run('tools', 'bb');
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      [...new Set(sent(bed.exit.offered, 'https://bb.example.com'))],
      [`Bearer ${VAULT}`]
    );
    assert.deepEqual(await jerkLog(bed.kernel), []);
  });

  it('ENOENT: no placeholder, no jerk, and a 401 points to Settings', async () => {
    await bed.reset(refused('ENOENT', 'no such record'));
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.deepEqual(sent(bed.exit.offered, 'https://bb.example.com'), [undefined]);
    assert.deepEqual(await jerkLog(bed.kernel), []);
  });

  it('ENOENT: a public server still works', async () => {
    await bed.reset(refused('ENOENT', 'no such record'));
    const { status, stderr } = await run('tools', 'open');
    assert.equal(status, 0, stderr);
    assert.deepEqual(await jerkLog(bed.kernel), []);
  });

  it('EINVAL for several records refuses clearly, with no jerk and nothing sent', async () => {
    await bed.reset(refused('EINVAL', 'several mcp records are bound to bb; ask for one by name'));
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.match(stderr, /several sign-ins for bb/);
    assert.ok(stderr.includes('Settings › MCP servers'), stderr);
    assert.equal(sent(bed.exit.offered, 'https://bb.example.com').length, 0);
    assert.deepEqual(await jerkLog(bed.kernel), []);
  });

  it('any other EINVAL refuses, with no jerk and nothing sent', async () => {
    await bed.reset(refused('EINVAL', 'server must be a string'));
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.match(stderr, /refused the placeholder request for bb/);
    assert.equal(sent(bed.exit.offered, 'https://bb.example.com').length, 0);
    assert.deepEqual(await jerkLog(bed.kernel), []);
  });

  for (const code of ['ETIMEDOUT', 'EIO']) {
    it(`${code}: no placeholder, no jerk, and a 401 does not ask for a sign-in`, async () => {
      await bed.reset(refused(code, 'vault trouble'));
      const { status, stderr } = await run('info', 'bb');
      assert.equal(status, 4, stderr);
      assert.ok(stderr.includes(NO_ANSWER), stderr);
      assert.ok(!stderr.includes(SETTINGS), stderr);
      assert.deepEqual(sent(bed.exit.offered, 'https://bb.example.com'), [undefined]);
      assert.deepEqual(await jerkLog(bed.kernel), []);
    });
  }

  it('a hook that throws reaches mcpcat as EIO', async () => {
    await bed.reset(() => {
      throw new Error('hook broke');
    });
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(NO_ANSWER), stderr);
    assert.deepEqual(await jerkLog(bed.kernel), []);
  });

  for (const [what, answer] of [
    ['ENOTCONN', refused('ENOTCONN', 'no vault')],
    ['an old vault without the op', refused('EINVAL', 'unknown op')],
    [
      'a 1.18 vault that needs a name',
      refused('EINVAL', 'name must match ^[A-Za-z_][A-Za-z0-9_]*$'),
    ],
  ]) {
    it(`${what}: falls back to jerk`, async () => {
      await bed.reset(answer);
      const { status, stderr } = await run('tools', 'bb');
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        [...new Set(sent(bed.exit.offered, 'https://bb.example.com'))],
        [`Bearer ${JERK}`]
      );
      assert.ok((await jerkGets()).length > 0);
    });
  }
});

describe('kernel: no /dev/sealed hook at all', {
  skip: !kernelAtLeast(86) && 'ctx.sync.cred and kernel.chmod need slicc-kernel >= 1.86.0',
}, () => {
  it('falls back to jerk', async () => {
    const bed = await bench({ jerk: true, hook: false });
    try {
      await bed.reset();
      const { status, stderr } = await mcpcat(bed.kernel, {})('tools', 'bb');
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        [...new Set(sent(bed.exit.offered, 'https://bb.example.com'))],
        [`Bearer ${JERK}`]
      );
    } finally {
      bed.close();
    }
  });
});

describe('kernel: a non-root user with jerk', {
  skip: !kernelAtLeast(86) && 'ctx.sync.cred and kernel.chmod need slicc-kernel >= 1.86.0',
}, () => {
  it('never asks the vault, even with a record for the server', async () => {
    const bed = await bench({ jerk: true });
    try {
      await bed.reset();
      const { status, stderr } = await mcpcat(bed.kernel, {}, AS_CONE)('tools', 'bb');
      assert.equal(status, 0, stderr);
      assert.equal(bed.vault.requests.length, 0);
      assert.deepEqual(
        [...new Set(sent(bed.exit.offered, 'https://bb.example.com'))],
        [`Bearer ${JERK}`]
      );
    } finally {
      bed.close();
    }
  });
});

describe('kernel: a non-root user without jerk', {
  skip: !kernelAtLeast(86) && 'ctx.sync.cred and kernel.chmod need slicc-kernel >= 1.86.0',
}, () => {
  let bed;
  let run;

  before(async () => {
    bed = await bench({ jerk: false });
    run = mcpcat(bed.kernel, {}, AS_CONE);
  });
  beforeEach(() => bed.reset());
  after(() => bed?.close());

  it('gets the root discovery hint, one request and no vault op', async () => {
    const { status, stderr } = await run('info', 'bb');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(stderr.includes(NATIVE_TOOLS), stderr);
    assert.ok(stderr.includes(PANEL_ROOT), stderr);
    assert.ok(!stderr.includes('mcpcat login'), stderr);
    assert.equal(bed.vault.requests.length, 0);
    assert.deepEqual(bed.upstream.seen.length, 1);
    assert.equal(bed.upstream.seen[0].authorization, undefined);
  });

  it('a URL target gets the plain Settings pointer', async () => {
    const { status, stderr } = await run('info', 'https://bb.example.com/mcp');
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes(SETTINGS), stderr);
    assert.ok(!stderr.includes(NATIVE_TOOLS), stderr);
    assert.equal(bed.vault.requests.length, 0);
  });
});
