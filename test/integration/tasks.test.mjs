import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const fixtures = join(here, 'fixtures');
const hostFixture = join(fixtures, 'tasks-server-host.mjs');

function collect(child) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('exit', (status) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status,
      })
    );
  });
}

async function startHttp() {
  const child = spawn(process.execPath, [hostFixture, '--http'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString()).port));
  });
  return { child, port };
}

function checks(run, targets) {
  for (const [label, target] of targets) {
    it(`${label}: call without --async gets the plain result`, async () => {
      const r = await run(['call', target(), 'build']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'sync\n');
    });

    it(`${label}: call --async prints the task handle`, async () => {
      const r = await run(['call', '--async', target(), 'build']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'done-1\n');
      assert.match(r.stderr, /task done-1 working; poll with: mcpcat task get .* done-1/);
    });

    it(`${label}: --json call --async prints the CreateTaskResult`, async () => {
      const r = await run(['--json', 'call', target(), 'build', '--async']);
      assert.equal(r.status, 0, r.stderr);
      const t = JSON.parse(r.stdout);
      assert.equal(t.resultType, 'task');
      assert.equal(t.taskId, 'done-1');
      assert.equal(t.status, 'working');
    });

    it(`${label}: task get renders a completed result`, async () => {
      const r = await run(['task', 'get', target(), 'done-1']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'built ok\n');
    });

    it(`${label}: task get of a tool error exits 1`, async () => {
      const r = await run(['task', 'get', target(), 'error-1']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /bad input/);
    });

    it(`${label}: task get of a working task`, async () => {
      const r = await run(['task', 'get', target(), 'work-1']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'work-1 working: compiling\n');
    });

    it(`${label}: task get of a failed task exits 5`, async () => {
      const r = await run(['task', 'get', target(), 'fail-1']);
      assert.equal(r.status, 5, r.stderr);
      assert.match(r.stderr, /fail-1 failed: boom/);
    });

    it(`${label}: task get of a cancelled task exits 1`, async () => {
      const r = await run(['task', 'get', target(), 'cancel-1']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /cancel-1 cancelled/);
    });

    it(`${label}: task get of an input_required task exits 6`, async () => {
      const r = await run(['task', 'get', target(), 'input-1']);
      assert.equal(r.status, 6, r.stderr);
      const req = JSON.parse(r.stderr);
      assert.equal(req.taskId, 'input-1');
      assert.equal(req.inputRequests.name.method, 'elicitation/create');
    });

    it(`${label}: --json task get prints the task`, async () => {
      const r = await run(['--json', 'task', 'get', target(), 'fail-1']);
      assert.equal(r.status, 5, r.stderr);
      const t = JSON.parse(r.stdout);
      assert.equal(t.status, 'failed');
      assert.equal(t.error.message, 'boom');
    });

    it(`${label}: an unknown task exits 5`, async () => {
      const r = await run(['task', 'get', target(), 'nope-1']);
      assert.equal(r.status, 5, r.stderr);
      assert.match(r.stderr, /Task not found/);
    });

    it(`${label}: --silent drops the polling and cancel notices`, async () => {
      const r = await run(['--silent', 'call', '--async', target(), 'build']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'done-1\n');
      assert.equal(r.stderr, '');
      const c = await run(['--silent', 'task', 'cancel', target(), 'work-1']);
      assert.equal(c.status, 0, c.stderr);
      assert.equal(c.stderr, '');
    });

    it(`${label}: task cancel`, async () => {
      const r = await run(['task', 'cancel', target(), 'work-1']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /cancel requested for task work-1/);
      const j = await run(['--json', 'task', 'cancel', target(), 'work-1']);
      assert.equal(j.status, 0, j.stderr);
      assert.deepEqual(JSON.parse(j.stdout), { resultType: 'complete' });
    });
  }
}

describe('host: tasks extension', () => {
  let home;
  let env;
  let http;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-tasks-'));
    env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, 'agent'),
    };
    http = await startHttp();
  });

  after(() => {
    http?.child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  });

  function run(args) {
    const { cmd, args: a } = mcpcatArgs(args);
    return collect(spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], env }));
  }

  checks(run, [
    ['stdio', () => `stdio:node ${hostFixture}`],
    ['http', () => `http://127.0.0.1:${http.port}/mcp`],
  ]);

  it('the poll hint shell-quotes the target and task id', async () => {
    const id = `it's $(touch nope) "x"`;
    const target = `stdio:node ${hostFixture}`;
    const r = await run(['call', '--async', target, 'build', '-d', JSON.stringify({ id })]);
    assert.equal(r.status, 0, r.stderr);
    const hint = r.stderr.split('poll with: mcpcat task get ')[1].trimEnd();
    const argv = execFileSync('sh', ['-c', `printf '%s\\0' ${hint}`], { cwd: home })
      .toString()
      .split('\0')
      .slice(0, -1);
    assert.deepEqual(argv, [target, id]);
  });

  it('task get -o writes a completed result to the file', async () => {
    const out = join(home, 'result.txt');
    const r = await run(['task', 'get', `stdio:node ${hostFixture}`, 'done-1', '-o', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(readFileSync(out, 'utf8'), 'built ok');
    const j = join(home, 'task.json');
    const rj = await run(['--json', '-o', j, 'task', 'get', `stdio:node ${hostFixture}`, 'work-1']);
    assert.equal(rj.status, 0, rj.stderr);
    assert.equal(rj.stdout, '');
    assert.equal(JSON.parse(readFileSync(j, 'utf8')).status, 'working');
  });

  it('call --async on a legacy server gets the plain result', async () => {
    const legacy = `stdio:node ${join(fixtures, 'server-stdio-legacy.mjs')}`;
    const r = await run(['call', '--async', legacy, 'echo', '--message', 'hi']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'hi\n');
  });

  for (const args of [
    ['task', 'bogus', 'x', 'id'],
    ['task', 'get', 'x'],
    ['task', 'get', 'x', 'id', 'extra'],
    ['task'],
  ]) {
    it(`usage error for ${args.join(' ')}`, async () => {
      const r = await run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /usage: mcpcat task get\|cancel <target> <id>/);
    });
  }

  it('--help names task and --async', async () => {
    const r = await run(['--help']);
    assert.match(r.stdout, /^ {2}task get\|cancel <target> <id>$/m);
    assert.match(r.stdout, /^ {2}--async {2,}/m);
  });
});

describe('kernel: tasks extension', () => {
  let kernel;
  let http;

  before(async () => {
    http = await startHttp();
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    const install = async (dir, command, module, data) => {
      await kernel.writeFile(`/node_modules/@ai-ecoverse/${dir}/${module}`, data);
      await kernel.writeFile(
        `/node_modules/@ai-ecoverse/${dir}/package.json`,
        JSON.stringify({
          name: `@ai-ecoverse/${dir}`,
          version: pkg.version,
          type: 'module',
          slicc: { commands: { [command]: { abi: 'js', module } } },
        })
      );
    };
    await install(
      'mcpcat',
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm',
      readFileSync(join(root, 'dist/quickjs.wasm'))
    );
    await install(
      'mcpcat-test-tasks',
      'tasks-srv',
      'dist/server.mjs',
      readFileSync(join(fixtures, 'tasks-server.mjs'))
    );
  });

  after(() => {
    http?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  function run(args) {
    return kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: '/etc/mcpcat-tasks' },
    });
  }

  checks(run, [
    ['stdio', () => 'stdio:tasks-srv'],
    ['http', () => `${hostUrl(http.port)}/mcp`],
  ]);
});
