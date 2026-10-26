import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const hostFixture = join(fixtures, 'events-server-host.mjs');
const X = ['--experimental', 'events'];

let runIds = 0;
const runId = () => `r${process.pid}-${++runIds}`;

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

async function startHttp(extra = []) {
  const child = spawn(process.execPath, [hostFixture, '--http', ...extra], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString()).port));
  });
  return { child, port };
}

const lines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function checks(run, targets, sink) {
  for (const [label, target, bare] of targets) {
    it(`${label}: --list-events prints every page of events/list`, async () => {
      const r = await run([target(), ...X, '--list-events']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^tick \[push, poll\] {2}A counter that ticks$/m);
      assert.match(r.stdout, /^ {2}Input schema:$/m);
      assert.match(r.stdout, /^ {2}Payload schema:$/m);
      assert.match(r.stdout, /^hook \[webhook\]$/m);
      assert.match(r.stdout, /^tricky \[push\]$/m);
    });

    it(`${label}: --list-events --json prints the merged events/list result`, async () => {
      const r = await run([target(), ...X, '--list-events', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const names = JSON.parse(r.stdout).events.map((e) => e.name);
      assert.deepEqual(names, [
        'tick',
        'mail.received',
        'flaky',
        'closer',
        'revoked',
        'broken',
        'hook',
        'tricky',
      ]);
    });

    it(`${label}: --subscribe prefers push and prints one occurrence per line`, async () => {
      const r = await run([target(), ...X, '--count', '3', '--subscribe', 'tick', '--label', 'hi']);
      assert.equal(r.status, 0, r.stderr);
      const events = lines(r.stdout);
      assert.deepEqual(
        events.map((e) => [e.eventId, e.data.n, e.data.label, e.cursor]),
        [
          ['tick-1', 1, 'hi', 'c1'],
          ['tick-2', 2, 'hi', 'c2'],
          ['tick-3', 3, 'hi', 'c3'],
        ]
      );
      assert.equal(events[0]._meta, undefined);
    });

    it(`${label}: --delivery poll drains hasMore without waiting`, async () => {
      const t = Date.now();
      const r = await run([
        target(),
        ...X,
        '--delivery',
        'poll',
        '--cursor',
        'c0',
        '--count',
        '3',
        '--subscribe',
        'tick',
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        lines(r.stdout).map((e) => [e.eventId, e.cursor]),
        [
          ['tick-1', undefined],
          ['tick-2', undefined],
          ['tick-3', undefined],
        ]
      );
      assert.ok(Date.now() - t < 5000);
    });

    it(`${label}: a poll-only event falls back to events/poll`, async () => {
      const r = await run([
        target(),
        ...X,
        '--count',
        '1',
        '--subscribe',
        'mail.received',
        '--from',
        'a@example.com',
      ]);
      assert.equal(r.status, 0, r.stderr);
      const [e] = lines(r.stdout);
      assert.equal(e.eventId, 'mail-1');
      assert.equal(e.data.from, 'a@example.com');
    });

    it(`${label}: -d gives the arguments as JSON`, async () => {
      const r = await run([
        target(),
        ...X,
        '-d',
        '{"from":"d@example.com"}',
        '--cursor',
        'c4',
        '--count',
        '1',
        '--subscribe',
        'mail.received',
      ]);
      assert.equal(r.status, 0, r.stderr);
      const [e] = lines(r.stdout);
      assert.deepEqual([e.eventId, e.data.from], ['mail-5', 'd@example.com']);
    });

    for (const delivery of ['push', 'poll']) {
      it(`${label}: truncated over ${delivery} is reported on stderr`, async () => {
        const r = await run([
          target(),
          ...X,
          '--delivery',
          delivery,
          '--cursor',
          'stale',
          '--count',
          '1',
          '--subscribe',
          'tick',
        ]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /events for tick were skipped \(truncated\); resuming/);
        assert.equal(lines(r.stdout)[0].data.n, 101);
      });
    }

    it(`${label}: --max-age is sent with the resume`, async () => {
      const r = await run([
        target(),
        ...X,
        '--cursor',
        'c7',
        '--max-age',
        '0.5',
        '--count',
        '1',
        '--subscribe',
        'tick',
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /skipped \(truncated\)/);
      assert.equal(lines(r.stdout)[0].data.n, 51);
    });

    it(`${label}: --silent drops notices`, async () => {
      const r = await run([
        target(),
        ...X,
        '--silent',
        '--cursor',
        'stale',
        '--count',
        '1',
        '--subscribe',
        'tick',
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    });

    it(`${label}: a quiet stream reconnects with the last cursor`, async () => {
      const r = await run([
        target(),
        ...X,
        '--heartbeat-timeout',
        '0.3',
        '--count',
        '2',
        '--subscribe',
        'flaky',
        '--run',
        runId(),
      ]);
      assert.equal(r.status, 0, r.stderr);
      const events = lines(r.stdout);
      assert.deepEqual(
        events.map((e) => e.eventId),
        ['flaky-1', 'flaky-2']
      );
      assert.equal(events[1].data.resumedFrom, 'c1');
      assert.match(r.stderr, /no event or heartbeat for 0\.3s; reconnecting in 0\.5s/);
    });

    it(`${label}: a stream the server closes reconnects with the last cursor`, async () => {
      const r = await run([
        target(),
        ...X,
        '--count',
        '2',
        '--subscribe',
        'closer',
        '--run',
        runId(),
      ]);
      assert.equal(r.status, 0, r.stderr);
      const events = lines(r.stdout);
      assert.deepEqual(
        events.map((e) => [e.eventId, e.data.resumedFrom]),
        [
          ['closer-1', null],
          ['closer-2', 'c1'],
        ]
      );
      assert.match(r.stderr, /the server closed the stream; reconnecting/);
    });

    it(`${label}: --cursor-file resumes and dedups by eventId`, async () => {
      const file = sink.path('cursor.json');
      const a = await run([
        target(),
        ...X,
        '--delivery',
        'poll',
        '--cursor',
        'c0',
        '--cursor-file',
        file,
        '--count',
        '3',
        '--subscribe',
        'tick',
      ]);
      assert.equal(a.status, 0, a.stderr);
      assert.deepEqual(
        lines(a.stdout).map((e) => e.eventId),
        ['tick-1', 'tick-2', 'tick-3']
      );
      const b = await run([
        target(),
        ...X,
        '--delivery',
        'poll',
        '--cursor-file',
        file,
        '--count',
        '1',
        '--subscribe',
        'tick',
      ]);
      assert.equal(b.status, 0, b.stderr);
      assert.deepEqual(
        lines(b.stdout).map((e) => e.eventId),
        ['tick-4']
      );
      if (sink.read) {
        const state = JSON.parse(await sink.read(file));
        assert.equal(state.event, 'tick');
        assert.equal(state.cursor, 'c4');
        assert.deepEqual(state.eventIds, ['tick-1', 'tick-2', 'tick-3', 'tick-4']);
      }
    });

    it(`${label}: -- cmd runs once per event with the occurrence on stdin`, async () => {
      const r = await run([
        target(),
        ...X,
        '--count',
        '2',
        '--subscribe',
        'tick',
        '--',
        ...sink.cmd,
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'tick-1 tick c1 1\ntick-2 tick c2 2\n');
    });

    it(`${label}: duplicates are dropped and payloads are escaped`, async () => {
      const r = await run([target(), ...X, '--count', '2', '--subscribe', 'tricky']);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /[\u0080-\u009f\u001b]/);
      const events = lines(r.stdout);
      assert.deepEqual(
        events.map((e) => e.eventId),
        ['dup', 'tricky-2']
      );
      assert.equal(events[0].data.text, 'red \u001b[31m and \u009b csi');
      assert.deepEqual(events[1]._meta, { 'example.com/trace': 't1' });
      assert.match(r.stderr, /server reported an error for tricky: UpstreamError \(-32603\)/);
    });

    it(`${label}: notifications/events/terminated with Forbidden exits 4`, async () => {
      const r = await run([target(), ...X, '--subscribe', 'revoked']);
      assert.equal(r.status, 4, r.stderr);
      assert.match(r.stderr, /subscription to revoked terminated by the server: Forbidden/);
    });

    for (const delivery of ['push', 'poll']) {
      it(`${label}: a JSON-RPC error to events/${delivery === 'push' ? 'stream' : 'poll'} exits 5`, async () => {
        const r = await run([target(), ...X, '--delivery', delivery, '--subscribe', 'broken']);
        assert.equal(r.status, 5, r.stderr);
        assert.match(r.stderr, /-32023: NotFound/);
      });
    }

    for (const [args, message] of [
      [['--subscribe', 'hook'], /event 'hook' offers no delivery mode mcpcat can use/],
      [['--delivery', 'push', '--subscribe', 'mail.received'], /does not offer push delivery/],
      [['--subscribe', 'nope'], /unknown event 'nope' \(events: tick, mail\.received/],
      [['--subscribe', 'mail.received'], /missing required flag --from/],
      [['--subscribe', 'tick', '--bogus', '1'], /bogus/],
    ]) {
      it(`${label}: ${args.join(' ')} exits 2`, async () => {
        const r = await run([target(), ...X, ...args]);
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, message);
      });
    }

    it(`${label}: a server without the extension exits 5`, async () => {
      const r = await run([bare(), ...X, '--list-events']);
      assert.equal(r.status, 5, r.stderr);
      assert.match(
        r.stderr,
        /does not offer the events extension \(io\.modelcontextprotocol\/events\)/
      );
    });

    it(`${label}: other verbs never declare the events capability`, async () => {
      const r = await run([...X, 'tools', target()]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'caps-none\n');
    });
  }
}

describe('host: events extension', () => {
  let home;
  let env;
  let http;
  let bareHttp;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-events-'));
    env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, 'agent'),
    };
    http = await startHttp();
    bareHttp = await startHttp(['--no-events']);
  });

  after(() => {
    http?.child.kill('SIGTERM');
    bareHttp?.child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  });

  function start(args) {
    const { cmd, args: a } = mcpcatArgs(args);
    return spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: home });
  }

  const run = (args) => collect(start(args));
  const stdio = `stdio:node ${hostFixture}`;
  let files = 0;
  const sink = {
    cmd: ['node', join(fixtures, 'event-sink.mjs')],
    path: (name) => join(home, `${++files}-${name}`),
    read: async (path) => readFileSync(path, 'utf8'),
  };

  checks(
    run,
    [
      ['stdio', () => stdio, () => `${stdio} --no-events`],
      [
        'http',
        () => `http://127.0.0.1:${http.port}/mcp`,
        () => `http://127.0.0.1:${bareHttp.port}/mcp`,
      ],
    ],
    sink
  );

  it('the event flags need --experimental events, and nothing starts without it', async () => {
    const marker = join(home, 'started');
    const script = join(home, 'mark.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`
    );
    for (const args of [
      [`stdio:node ${script}`, '--subscribe', 'tick'],
      [`stdio:node ${script}`, '--list-events'],
    ]) {
      const r = await run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /--list-events and --subscribe need --experimental events/);
    }
    assert.equal(existsSync(marker), false);
  });

  for (const [args, message] of [
    [['--experimental'], /--experimental needs a feature name \(known: events\)/],
    [['--experimental', '--json', 'info', 'x'], /--experimental needs a feature name/],
    [
      ['--experimental', 'nope', 'info', 'x'],
      /unknown experimental feature 'nope' \(known: events\)/,
    ],
    [['--experimental=events,', 'info', 'x'], /needs a feature name/],
    [['x', ...X, '--list-events', '--subscribe', 'tick'], /do not combine/],
    [['x', ...X, '--list-events', '--', 'cat'], /a command after -- needs --subscribe/],
    [['x', ...X, '--subscribe', 'tick', '--'], /no command after --/],
    [['x', ...X, '--subscribe'], /--subscribe needs an event name/],
    [['x', ...X, '--count', '0', '--subscribe', 'tick'], /--count needs a positive integer/],
    [
      ['x', ...X, '--delivery', 'webhook', '--subscribe', 'tick'],
      /--delivery must be push or poll/,
    ],
    [['x', ...X, '--list-events', 'y'], /unexpected argument 'y'/],
    [[...X, '--list-events'], /no target given/],
  ]) {
    it(`usage error for ${args.join(' ')}`, async () => {
      const r = await run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
    });
  }

  it('--experimental=events works too', async () => {
    const r = await run([stdio, '--experimental=events', '--list-events', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).events.length, 8);
  });

  it('--version --verbose lists the experimental features and their revision', async () => {
    const v = await run(['--version']);
    assert.equal(v.stdout, `${pkg.version}\n`);
    const r = await run(['--version', '--verbose']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${pkg.version.replace(/\./g, '\\.')}\\n`));
    assert.match(r.stdout, /^ {2}events {21}MCP Events client/m);
    assert.match(
      r.stdout,
      /^ +SEP-3415 at modelcontextprotocol\/modelcontextprotocol@b0efd116faca$/m
    );
  });

  it('--help names --experimental, --list-events and --subscribe', async () => {
    const r = await run(['--help']);
    assert.match(r.stdout, /^Experimental \(--experimental <feature>/m);
    assert.match(r.stdout, /can change or\s+disappear in any minor release/);
    assert.match(r.stdout, /--list-events/);
    assert.match(r.stdout, /--subscribe <event>/);
  });

  it('a handler that fails is reported and the next event still runs', async () => {
    const r = await run([
      stdio,
      ...X,
      '--count',
      '2',
      '--subscribe',
      'tick',
      '--',
      'node',
      join(fixtures, 'event-sink.mjs'),
      '3',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'tick-1 tick c1 1\ntick-2 tick c2 2\n');
    assert.match(r.stderr, /node exited 3 for event tick-1/);
    assert.match(r.stderr, /node exited 3 for event tick-2/);
  });

  it('a handler that cannot start exits 2', async () => {
    const r = await run([
      stdio,
      ...X,
      '--count',
      '1',
      '--subscribe',
      'tick',
      '--',
      join(home, 'nope'),
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cannot run .*nope/);
  });

  it('--since now ignores the cursor file but still writes it', async () => {
    const file = join(home, 'since.json');
    writeFileSync(file, JSON.stringify({ cursor: 'stale', eventIds: [] }));
    const r = await run([
      stdio,
      ...X,
      '--since',
      'now',
      '--cursor-file',
      file,
      '--count',
      '1',
      '--subscribe',
      'tick',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(r.stdout)[0].data.n, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).cursor, 'c1');
  });

  it('a broken cursor file exits 2', async () => {
    const file = join(home, 'broken.json');
    writeFileSync(file, '{');
    const r = await run([stdio, ...X, '--cursor-file', file, '--subscribe', 'tick']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cannot read --cursor-file/);
  });

  it('stdio: --count cancels the stream with notifications/cancelled', async () => {
    const r = await run(['-v', stdio, ...X, '--count', '1', '--subscribe', 'tick']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stderr,
      /> notifications\/cancelled\n> \{"jsonrpc":"2\.0","method":"notifications\/cancelled","params":\{"requestId":\d+,"reason":"done"\}\}/
    );
  });

  it('http: events requests carry Mcp-Name and the events capability', async () => {
    const r = await run([
      '-v',
      `http://127.0.0.1:${http.port}/mcp`,
      ...X,
      '--count',
      '1',
      '--subscribe',
      'tick',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /> Mcp-Name: tick/i);
    assert.match(r.stderr, /"extensions":\{"io\.modelcontextprotocol\/events":\{\}\}/);
  });

  for (const [label, target] of [
    ['stdio', () => stdio],
    ['http', () => `http://127.0.0.1:${http.port}/mcp`],
  ]) {
    it(`${label}: SIGINT ends a subscription with 130`, async () => {
      const child = start([target(), ...X, '--subscribe', 'tick', '--every', '200']);
      const done = collect(child);
      await new Promise((resolve) => child.stdout.once('data', resolve));
      child.kill('SIGINT');
      const r = await done;
      assert.equal(r.status, 130, r.stderr);
      assert.match(r.stderr, /interrupted/);
    });
  }

  it('a legacy server says events need 2026-07-28', async () => {
    const legacy = `stdio:node ${join(fixtures, 'server-stdio-legacy.mjs')}`;
    const r = await run([legacy, ...X, '--list-events']);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /events need protocol 2026-07-28; this server speaks 20\d\d-\d\d-\d\d/);
  });
});

describe('kernel: events extension', () => {
  let kernel;
  let http;
  let bareHttp;

  before(async () => {
    http = await startHttp();
    bareHttp = await startHttp(['--no-events']);
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
      'mcpcat-test-events',
      'events-srv',
      'dist/server.mjs',
      readFileSync(join(fixtures, 'events-server.mjs'))
    );
    await install(
      'mcpcat-test-event-sink',
      'event-sink',
      'dist/sink.mjs',
      readFileSync(join(fixtures, 'kernel-event-sink.mjs'))
    );
  });

  after(() => {
    http?.child.kill('SIGTERM');
    bareHttp?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  function run(args) {
    return kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: '/etc/mcpcat-events' },
    });
  }

  let files = 0;
  checks(
    run,
    [
      ['stdio', () => 'stdio:events-srv', () => 'stdio:events-srv --no-events'],
      ['http', () => `${hostUrl(http.port)}/mcp`, () => `${hostUrl(bareHttp.port)}/mcp`],
    ],
    {
      cmd: ['event-sink'],
      path: (name) => `/tmp/${++files}-${name}`,
      read: async (path) => new TextDecoder().decode(await kernel.readFile(path)),
    }
  );
});
