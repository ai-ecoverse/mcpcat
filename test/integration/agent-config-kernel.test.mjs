import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createNodeKernel, hostUrl, kernelAtLeast, nodeTransport } from './helpers/kernel.mjs';
import { fixtures, root, startFixture } from './helpers/rows.mjs';

const AGENT_DIR = '/etc/slicc/agent';
const AGENT_FILE = `${AGENT_DIR}/mcp.json`;
const HOME_FILE = '/home/cone/.pi/agent/mcp.json';
const LEGACY_FILE = '/root/.pi/agent/mcp.json';
const HINT = `mcpcat: servers found in ${LEGACY_FILE} that the agent does not read; run "mcpcat import ${LEGACY_FILE}" to copy them to ${AGENT_FILE} (the agent still refuses stdio, literal secrets and sse entries)`;
const URL_ = 'https://mcp.example.com/mcp';
const NOTE =
  /note: the agent doesn't read \/home\/cone\/\.pi\/agent\/mcp\.json; add the server in Settings › MCP servers, or run mcpcat as root/;

describe('the agent config file in the kernel', {
  skip: !kernelAtLeast(74) && 'users need slicc-kernel >= 1.74.0',
}, () => {
  let kernel;
  let srv;
  const run = (argv, opts = {}) => kernel.run(argv, { stdout: 'pipe', stderr: 'pipe', ...opts });
  const fsOp = async (...argv) => {
    const r = await run(['kernel-probe-fs', ...argv]);
    assert.equal(r.status, 0, r.stderr);
  };
  const add = (opts) => run(['mcpcat', 'add', 'docs', URL_, '--no-probe'], opts);
  const modes = async (...paths) =>
    (await run(['kernel-probe-stat', ...paths])).stdout.trim().split('\n');
  const servers = async (path, opts) =>
    Object.keys(JSON.parse((await run(['kernel-probe-cat', path], opts)).stdout).mcpServers);

  before(async () => {
    srv = await startFixture('server-2026-http.mjs');
    kernel = await createNodeKernel({
      users: 'enforce',
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    for (const [name, module, data] of [
      ['mcpcat', 'dist/kernel/mcpcat.mjs', readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))],
      ['kernel-probe-stat', 'main.mjs', readFileSync(join(fixtures, 'kernel-probe-stat.mjs'))],
      ['kernel-probe-cat', 'main.mjs', readFileSync(join(fixtures, 'kernel-probe-cat.mjs'))],
      ['kernel-probe-fs', 'main.mjs', readFileSync(join(fixtures, 'kernel-probe-fs.mjs'))],
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

  after(() => {
    kernel?.terminate();
    srv?.child.kill('SIGTERM');
  });

  describe('as root', () => {
    beforeEach(async () => {
      await fsOp('rm', '/etc/slicc');
      await fsOp('rm', '/root/.pi');
    });

    it('add creates the directory and writes the agent file 0600', async () => {
      const r = await add();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `added docs in ${AGENT_FILE}\n`);
      assert.equal(r.stderr, '');
      assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\t600`]);
      assert.deepEqual(await servers(AGENT_FILE), ['docs']);
      assert.deepEqual(await modes('/root/.pi/agent/mcp.json'), [
        '/root/.pi/agent/mcp.json\tENOENT',
      ]);
    });

    it('list, enable, disable, exposure, import and rm all use the agent file', async () => {
      await add();
      assert.match(
        (await run(['mcpcat', 'list'])).stdout,
        /^docs .*\(\/etc\/slicc\/agent\/mcp\.json\)$/m
      );
      assert.equal(
        (await run(['mcpcat', 'disable', 'docs'])).stdout,
        `disabled docs in ${AGENT_FILE}\n`
      );
      assert.equal(
        (await run(['mcpcat', 'enable', 'docs'])).stdout,
        `enabled docs in ${AGENT_FILE}\n`
      );
      assert.equal(
        (await run(['mcpcat', 'exposure', 'docs', 'direct'])).stdout,
        `set docs to direct in ${AGENT_FILE}\n`
      );
      await kernel.writeFile(
        '/tmp/import.json',
        JSON.stringify({ mcpServers: { more: { url: URL_ } } })
      );
      assert.equal((await run(['mcpcat', 'import', '/tmp/import.json'])).status, 0);
      assert.deepEqual(await servers(AGENT_FILE), ['docs', 'more']);
      assert.equal(
        (await run(['mcpcat', 'rm', 'more'])).stdout,
        `removed more from ${AGENT_FILE}\n`
      );
      assert.deepEqual(await servers(AGENT_FILE), ['docs']);
      assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\t600`]);
    });

    it('keeps an existing 0755 /etc/slicc/agent, and a regular user cannot read the file', async () => {
      await fsOp('mkdir', AGENT_DIR);
      await fsOp('chmod', '/etc/slicc', '755');
      await fsOp('chmod', AGENT_DIR, '755');
      assert.equal((await add()).status, 0);
      assert.deepEqual(await modes('/etc/slicc', AGENT_DIR), [
        '/etc/slicc\t755',
        `${AGENT_DIR}\t755`,
      ]);
      const r = await run(['kernel-probe-cat', AGENT_FILE], { user: 'cone' });
      assert.notEqual(r.status, 0);
    });

    it('a server call keeps /etc/slicc and /etc/slicc/agent open', async () => {
      await fsOp('mkdir', AGENT_DIR);
      await fsOp('chmod', '/etc/slicc', '755');
      await fsOp('chmod', AGENT_DIR, '755');
      const url = `${hostUrl(srv.port)}/mcp`;
      assert.equal((await run(['mcpcat', 'add', 'live', url, '--no-probe'])).status, 0);
      const tools = await run(['mcpcat', 'tools', 'live']);
      assert.equal(tools.status, 0, tools.stderr);
      assert.deepEqual(await modes('/etc/slicc', AGENT_DIR), [
        '/etc/slicc\t755',
        `${AGENT_DIR}\t755`,
      ]);
    });

    it('a rewrite tightens a looser file and never loosens a stricter one', async () => {
      await fsOp('mkdir', AGENT_DIR);
      await kernel.writeFile(AGENT_FILE, '{ "mcpServers": {} }\n');
      await fsOp('chmod', AGENT_FILE, '644');
      assert.equal((await add()).status, 0);
      assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\t600`]);
      await fsOp('chmod', AGENT_FILE, '400');
      assert.equal((await run(['mcpcat', 'rm', 'docs'])).status, 0);
      assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\t400`]);
    });

    it('PI_CODING_AGENT_DIR wins', async () => {
      const r = await add({ env: { PI_CODING_AGENT_DIR: '/tmp/root-pi' } });
      assert.equal(r.stdout, 'added docs in /tmp/root-pi/mcp.json\n', r.stderr);
      assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\tENOENT`]);
    });

    describe('servers left in /root/.pi/agent', () => {
      const legacy = async (mcpServers, path = LEGACY_FILE) => {
        const dir = path.slice(0, path.lastIndexOf('/'));
        await fsOp('mkdir', dir.slice(0, dir.lastIndexOf('/')));
        await fsOp('mkdir', dir);
        await kernel.writeFile(path, JSON.stringify({ mcpServers }));
      };
      const hints = (stderr) => stderr.split('\n').filter((l) => l.includes('does not read'));

      it('list prints one hint on stderr and keeps its output and exit code', async () => {
        await legacy({ docs: { url: URL_ } });
        const r = await run(['mcpcat', 'list']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, 'no servers configured\n');
        assert.equal(r.stderr, `${HINT}\n`);
      });

      it('list --json keeps stdout parseable', async () => {
        await legacy({ docs: { url: URL_ } });
        const r = await run(['mcpcat', 'list', '--json']);
        assert.deepEqual(JSON.parse(r.stdout), {});
        assert.equal(r.stderr, `${HINT}\n`);
      });

      it('list --config stays silent because the file was named', async () => {
        await legacy({ docs: { url: URL_ } });
        await kernel.writeFile('/tmp/named.json', '{ "mcpServers": {} }\n');
        const r = await run(['mcpcat', 'list', '--config', '/tmp/named.json']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
      });

      it('mentions mcp-auth.json without reading it', async () => {
        await legacy({ docs: { url: URL_ } });
        await kernel.writeFile('/root/.pi/agent/mcp-auth.json', '{"docs":{"tokens":"sekrit"}}');
        const { stderr } = await run(['mcpcat', 'list']);
        assert.equal(hints(stderr).length, 1);
        assert.equal(stderr.split('\n').length, 2);
        assert.match(
          stderr,
          /; tokens in \/root\/\.pi\/agent\/mcp-auth\.json stay there, so sign in again in Settings › MCP servers\n$/
        );
        assert.doesNotMatch(stderr, /sekrit/);
      });

      it('a failed name target names the legacy file and hints once', async () => {
        await legacy({ docs: { url: URL_ } });
        const r = await run(['mcpcat', 'tools', 'docs']);
        assert.equal(r.status, 2);
        assert.equal(hints(r.stderr).length, 1);
        assert.match(
          r.stderr,
          /unknown target 'docs': not a URL and not found in mcp\.json; found in \/root\/\.pi\/agent\/mcp\.json/
        );
      });

      it('finds the name the way a lookup does, and two failures still hint once', async () => {
        await legacy({ 'my-docs': { url: URL_ } });
        const r = await run(['mcpcat', 'code', '-e', '1', '-s', 'MY_DOCS', '-s', 'other']);
        assert.equal(hints(r.stderr).length, 1, r.stderr);
        assert.match(r.stderr, /'MY_DOCS': .*; found in \/root\/\.pi\/agent\/mcp\.json/);
        assert.match(r.stderr, /'other': not a URL and not found in mcp\.json\n/);
      });

      it('a name the legacy file lacks keeps the plain error beside the hint', async () => {
        await legacy({ docs: { url: URL_ } });
        const r = await run(['mcpcat', 'tools', 'typo']);
        assert.equal(r.status, 2);
        assert.equal(hints(r.stderr).length, 1);
        assert.match(r.stderr, /'typo': not a URL and not found in mcp\.json\n/);
      });

      it('--json keeps stderr one JSON error that names the legacy file', async () => {
        await legacy({ docs: { url: URL_ } });
        const r = await run(['mcpcat', 'tools', 'docs', '--json']);
        assert.equal(r.status, 2);
        assert.match(
          JSON.parse(r.stderr).error.message,
          /; found in \/root\/\.pi\/agent\/mcp\.json/
        );
      });

      it('serve --proxy names the legacy file too', async () => {
        await legacy({ docs: { url: URL_ } });
        const r = await run(['mcpcat', 'serve', '--proxy', 'docs', '--http', '0', '--no-auth']);
        assert.notEqual(r.status, 0);
        assert.equal(hints(r.stderr).length, 1, r.stderr);
        assert.match(r.stderr, /; found in \/root\/\.pi\/agent\/mcp\.json/);
      });

      it('stays silent when the agent file has every legacy name', async () => {
        await legacy({ docs: { url: URL_ }, 'my-docs': { url: URL_ } });
        await add();
        await run(['mcpcat', 'add', 'my_docs', URL_, '--no-probe']);
        const r = await run(['mcpcat', 'list']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
        assert.match((await run(['mcpcat', 'tools', 'nope'])).stderr, /^mcpcat: unknown target/);
      });

      it('copies only the missing names when the agent file has some', async () => {
        await legacy({ docs: { url: `${URL_}/old` }, more: { url: URL_ } });
        await add();
        const { stderr } = await run(['mcpcat', 'list']);
        assert.equal(hints(stderr).length, 1);
        assert.match(stderr, /run "mcpcat import \/root\/\.pi\/agent\/mcp\.json more" to copy/);
        const imported = await run(['mcpcat', 'import', LEGACY_FILE, 'more']);
        assert.equal(imported.stdout, 'imported more\n', imported.stderr);
        assert.equal((await run(['mcpcat', 'list'])).stderr, '');
        const { mcpServers } = JSON.parse((await run(['kernel-probe-cat', AGENT_FILE])).stdout);
        assert.equal(mcpServers.docs.url, URL_);
      });

      it('stays silent when the legacy file is empty, invalid or names no server', async () => {
        for (const text of ['', 'nope', '{}', '{ "mcpServers": {} }']) {
          await legacy({});
          await kernel.writeFile(LEGACY_FILE, text);
          const r = await run(['mcpcat', 'list']);
          assert.equal(r.status, 0, r.stderr);
          assert.equal(r.stderr, '');
        }
      });

      it('stays silent with PI_CODING_AGENT_DIR set', async () => {
        await legacy({ docs: { url: URL_ } });
        const env = { PI_CODING_AGENT_DIR: '/tmp/root-pi-empty' };
        assert.equal((await run(['mcpcat', 'list'], { env })).stderr, '');
        const r = await run(['mcpcat', 'tools', 'docs'], { env });
        assert.equal(r.status, 2);
        assert.equal(hints(r.stderr).length, 0);
        assert.doesNotMatch(r.stderr, /found in \//);
      });

      it('the import it names writes the agent file 0600 and warns about refused entries', async () => {
        await legacy({
          docs: { url: URL_ },
          local: { command: 'server', args: ['--stdio'] },
          leaky: { url: URL_, headers: { Authorization: 'Bearer sekrit' } },
          old: { type: 'sse', url: URL_ },
        });
        const r = await run(['mcpcat', 'import', LEGACY_FILE]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, 'imported docs\nimported local\nimported leaky\n');
        assert.match(
          r.stderr,
          /warning: local: stdio servers need .*the agent will skip this entry/
        );
        assert.match(r.stderr, /warning: leaky: headers\.Authorization holds a literal secret/);
        assert.match(r.stderr, /old: legacy SSE transport is not supported/);
        assert.doesNotMatch(r.stderr, /sekrit/);
        assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\t600`]);
        assert.deepEqual(await servers(AGENT_FILE), ['docs', 'local', 'leaky']);
        const after = await run(['mcpcat', 'list']);
        assert.equal(after.status, 0, after.stderr);
        assert.equal(after.stderr, '');
      });
    });
  });

  describe('as a regular user', () => {
    const opts = { user: 'cone' };

    beforeEach(async () => {
      for (const path of ['/home/cone/.pi', '/tmp/cone-pi', '/tmp/cone.json'])
        await fsOp('rm', path);
    });

    it('add keeps ~/.pi/agent/mcp.json, notes it on stderr and exits 0', async () => {
      const r = await add(opts);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `added docs in ${HOME_FILE}\n`);
      assert.match(r.stderr, NOTE);
      assert.deepEqual(await servers(HOME_FILE, opts), ['docs']);
    });

    it('enable, disable, exposure and import note it too; rm does not', async () => {
      await add(opts);
      await run(['mcpcat', 'disable', 'docs'], opts).then((r) => assert.match(r.stderr, NOTE));
      await run(['mcpcat', 'enable', 'docs'], opts).then((r) => assert.match(r.stderr, NOTE));
      await run(['mcpcat', 'exposure', 'docs', 'direct'], opts).then((r) =>
        assert.match(r.stderr, NOTE)
      );
      await kernel.writeFile(
        '/tmp/cone-import.json',
        JSON.stringify({ mcpServers: { more: { url: URL_ } } })
      );
      await fsOp('chmod', '/tmp/cone-import.json', '644');
      await run(['mcpcat', 'import', '/tmp/cone-import.json'], opts).then((r) =>
        assert.match(r.stderr, NOTE)
      );
      const removed = await run(['mcpcat', 'rm', 'more'], opts);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(removed.stderr, '');
    });

    it('a probe failure keeps its exit code and the note', async () => {
      const r = await run(['mcpcat', 'add', 'gone', 'http://127.0.0.1:9/mcp'], opts);
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, NOTE);
    });

    it('stays quiet when PI_CODING_AGENT_DIR, --config or -l picks the file', async () => {
      for (const r of [
        await add({ ...opts, env: { PI_CODING_AGENT_DIR: '/tmp/cone-pi' } }),
        await run(
          ['mcpcat', 'add', 'docs', URL_, '--no-probe', '--config', '/tmp/cone.json'],
          opts
        ),
        await run(['mcpcat', 'add', 'docs', URL_, '--no-probe', '-l'], {
          ...opts,
          cwd: '/home/cone',
        }),
      ]) {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
      }
    });

    it('gets no legacy hint: the home file is its own file', async () => {
      await add(opts);
      const list = await run(['mcpcat', 'list'], opts);
      assert.equal(list.status, 0, list.stderr);
      assert.equal(list.stderr, '');
      const failed = await run(['mcpcat', 'tools', 'nope'], opts);
      assert.equal(failed.status, 2);
      assert.equal(failed.stderr.includes('does not read'), false);
      assert.equal(failed.stderr.includes('found in /'), false);
    });

    it('never writes the agent file', async () => {
      await fsOp('rm', '/etc/slicc');
      await add(opts);
      assert.deepEqual(await modes(AGENT_FILE), [`${AGENT_FILE}\tENOENT`]);
    });
  });
});
