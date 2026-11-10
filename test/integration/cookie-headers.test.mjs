import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNodeKernel, fetchTransport, hostUrl, nodeTransport } from './helpers/kernel.mjs';
import { homeEnv, root, run, scratchHome, startFixture } from './helpers/rows.mjs';

const DUMMY = 'fjv3_session=dummy-not-a-credential';
const HEADERS = ['-H', `Cookie: ${DUMMY}`, '-H', 'X-Probe: visible'];
const WARNING =
  "mcpcat: warning: mcpcat won't send Cookie from the kernel: its fetch drops forbidden request headers (ai-ecoverse/slicc-kernel#1796)\n";
const AGENT_DIR = '/etc/slicc/agent';
const AGENT_FILE = `${AGENT_DIR}/mcp.json`;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const PAGE_DROPS = new Set(['cookie', 'cookie2', 'host', 'origin', 'referer']);

function pageFetch(input, init = {}) {
  const headers = new Headers();
  for (const [name, value] of new Headers(init.headers)) {
    if (!PAGE_DROPS.has(name)) headers.append(name, value);
  }
  const url = String(input).replace('//host.slicc.internal:', '//127.0.0.1:');
  return fetch(url, { ...init, headers });
}

describe('literal secrets in a Cookie header', () => {
  let home;
  const add = (name, header) =>
    run(['add', '--no-probe', name, 'https://example.com/mcp', '-H', header], {
      env: homeEnv(home),
    });
  const written = () =>
    JSON.parse(readFileSync(join(home, '.pi/agent/mcp.json'), 'utf8')).mcpServers;

  before(() => {
    home = scratchHome('cookie-literal');
  });

  const accepted = {
    'a name=${NAME} pair': 'Cookie: fjv3_session=${FJ_SESSION}',
    'pairs separated by "; "': 'Cookie: a=${A}; b=${B}',
    'a trailing ";"': 'Cookie: a=${A};',
    'a whole-cookie placeholder': 'Cookie: ${FJ_COOKIE}',
    'a placeholder next to a pair': 'Cookie: ${FJ_COOKIE}; b=${B}',
  };
  for (const [title, header] of Object.entries(accepted)) {
    it(`accepts ${title}`, () => {
      const name = `ok-${Object.keys(accepted).indexOf(title)}`;
      const r = add(name, header);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /literal secret/);
      assert.equal(written()[name].headers.Cookie, header.slice('Cookie: '.length));
    });
  }

  const refused = {
    'a literal value': `Cookie: ${DUMMY}`,
    'a literal value next to a placeholder pair': 'Cookie: a=${A}; b=dummy',
    'a literal glued to a placeholder': 'Cookie: a=${A}dummy',
    'a literal before a placeholder': 'Cookie: a=dummy${A}',
    'a name with no value': 'Cookie: a=',
    'a bare literal': 'Cookie: dummy',
    'a literal name=value outside Cookie': 'X-Session: a=${A}',
  };
  for (const [title, header] of Object.entries(refused)) {
    it(`refuses ${title}`, () => {
      const name = `bad-${Object.keys(refused).indexOf(title)}`;
      const r = add(name, header);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /holds a literal secret/);
      assert.equal(written()[name], undefined);
    });
  }
});

describe('-v on the host traces a Cookie header it sends', () => {
  let srv;
  let home;

  before(async () => {
    srv = await startFixture('cookie-echo-server.mjs');
    home = scratchHome('cookie-host');
  });

  after(() => srv?.child.kill('SIGTERM'));

  it('sends the cookie, traces it redacted and warns about nothing', () => {
    const r = run([...HEADERS, '-v', 'call', `${srv.base}/mcp`, 'seen'], { env: homeEnv(home) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'cookie present, x-probe visible');
    assert.match(r.stderr, /^> Cookie: \[REDACTED\]$/m);
    assert.match(r.stderr, /^> X-Probe: visible$/m);
    assert.doesNotMatch(r.stderr, /warning/);
    assert.doesNotMatch(r.stderr, /dummy-not-a-credential/);
  });
});

async function installMcpcat(kernel) {
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
}

const routes = {
  'the node transport, which could carry it': () => nodeTransport({ hostLoopback: true }),
  "a page transport, whose fetch drops it the way a browser's does": () =>
    fetchTransport({ fetch: pageFetch }),
};

for (const [route, transport] of Object.entries(routes)) {
  describe(`kernel: -v never traces a Cookie header as sent, on ${route}`, () => {
    let srv;
    let kernel;
    let target;
    const mcpcat = (argv, env = {}) =>
      kernel.run(['mcpcat', ...argv], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PI_CODING_AGENT_DIR: AGENT_DIR, ...env },
      });

    before(async () => {
      srv = await startFixture('cookie-echo-server.mjs');
      target = `${hostUrl(srv.port)}/mcp`;
      kernel = await createNodeKernel({ network: { transport: transport() } });
      await installMcpcat(kernel);
    });

    after(() => {
      kernel?.terminate();
      srv?.child.kill('SIGTERM');
    });

    it('-H Cookie: warns, leaves it out of the trace and out of the request', async () => {
      const r = await mcpcat([...HEADERS, '-v', 'call', target, 'seen']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'cookie absent, x-probe visible');
      assert.ok(r.stderr.startsWith(WARNING), r.stderr);
      assert.equal(r.stderr.split(WARNING).length, 2, r.stderr);
      assert.doesNotMatch(r.stderr, /^> Cookie:/im);
      assert.match(r.stderr, /^> X-Probe: visible$/m);
      assert.doesNotMatch(r.stderr, /dummy-not-a-credential/);
    });

    it('without -v, -H Cookie still warns', async () => {
      const r = await mcpcat([...HEADERS, 'call', target, 'seen']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'cookie absent, x-probe visible');
      assert.equal(r.stderr, WARNING);
    });

    it('a Cookie header from mcp.json warns the same way', async () => {
      await kernel.writeFile(
        AGENT_FILE,
        JSON.stringify({
          mcpServers: {
            fj: { url: target, headers: { Cookie: 'fjv3_session=${FJ_SESSION}' } },
          },
        })
      );
      const r = await mcpcat(['-v', 'call', 'fj', 'seen'], {
        FJ_SESSION: 'dummy-not-a-credential',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'cookie absent, x-probe absent');
      assert.ok(r.stderr.startsWith(WARNING), r.stderr);
      assert.doesNotMatch(r.stderr, /^> Cookie:/im);
      assert.doesNotMatch(r.stderr, /dummy-not-a-credential/);
    });

    it('add takes Cookie: name=${NAME} and warns that mcpcat here will not send it', async () => {
      const r = await mcpcat([
        'add',
        '--no-probe',
        'fj2',
        target,
        '-H',
        'Cookie: fjv3_session=${FJ_SESSION}',
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stderr,
        "mcpcat add: warning: mcpcat won't send Cookie from the kernel: its fetch drops forbidden request headers (ai-ecoverse/slicc-kernel#1796)\n"
      );
    });

    it('import into the agent file takes Cookie: name=${NAME}, refuses a literal, and warns once', async () => {
      await kernel.writeFile(
        '/tmp/cookies.json',
        JSON.stringify({
          mcpServers: {
            named: { url: target, headers: { Cookie: 'fjv3_session=${FJ_SESSION}' } },
            leaky: { url: target, headers: { Cookie: DUMMY } },
          },
        })
      );
      const r = await mcpcat(['import', '/tmp/cookies.json']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'imported named\nimported leaky\n');
      assert.equal(
        r.stderr,
        "mcpcat import: warning: mcpcat won't send Cookie from the kernel: its fetch drops forbidden request headers (ai-ecoverse/slicc-kernel#1796)\n" +
          'mcpcat import: warning: leaky: headers.Cookie holds a literal secret; write ${NAME} instead, and add the value in Settings > MCP servers\n'
      );
    });

    it('headers fetch can send pass without a warning', async () => {
      const r = await mcpcat(['-H', 'X-Probe: visible', '-v', 'call', target, 'seen']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'cookie absent, x-probe visible');
      assert.doesNotMatch(r.stderr, /warning/);
    });
  });
}
