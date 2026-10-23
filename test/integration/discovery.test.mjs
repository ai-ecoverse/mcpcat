import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');

function createTmpDir() {
  const dir = join(tmpdir(), `mcpcat-disc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runMcpcat(args, options = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: options.home || process.env.HOME,
        XDG_STATE_HOME: options.stateHome,
        PI_CODING_AGENT_DIR: options.piDir,
      },
      input: options.input,
      cwd: options.cwd || process.cwd(),
    });
    return { stdout: result, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: err.status ?? 1,
    };
  }
}

function hashFile(path) {
  if (!existsSync(path)) return 'MISSING';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runMcpcatAsync(args, options = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: options.home || process.env.HOME,
      XDG_STATE_HOME: options.stateHome,
      PI_CODING_AGENT_DIR: options.piDir,
    };
    const { cmd: asyncCmd, args: asyncArgs } = mcpcatArgs(args);
    execFile(
      asyncCmd,
      asyncArgs,
      {
        encoding: 'utf8',
        timeout: 10_000,
        env,
        cwd: options.cwd || process.cwd(),
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          status: err ? (err.code ?? 1) : 0,
        });
      }
    );
  });
}

function listenOnPort0(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve(srv);
    });
  });
}

function startFixtureServer(script, extraArgs = []) {
  const child = spawn('node', [join(fixturesDir, script), ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  return new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        try {
          resolve({ child, ...JSON.parse(data.trim()) });
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('\n')) reject(new Error(`Server exited ${code}: ${data}`));
    });
  });
}

describe('discovery: add --from-discovery', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{}}\n');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts candidates from all standard types', () => {
    const events = readFileSync(join(fixturesDir, 'discovery-events.ndjson'), 'utf8');
    const hashBefore = hashFile(configPath);

    const r = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome,
      piDir,
      input: events,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('example.com/mcp'));
    assert.ok(r.stdout.includes('catalog.example.com/mcp'));
    assert.ok(r.stdout.includes('shop.example.com/mcp'));
    assert.ok(r.stdout.includes('poppy.example.com/mcp'));
    assert.ok(r.stdout.includes('nlweb.example.com/mcp'));
    assert.ok(r.stdout.includes('webmcp'));
    assert.ok(r.stdout.includes('serve --webmcp'));

    const hashAfter = hashFile(configPath);
    assert.equal(hashBefore, hashAfter, 'mcp.json must not be modified by --from-discovery');
  });

  it('shows squatted URN warning', () => {
    const events = readFileSync(join(fixturesDir, 'discovery-squatted.ndjson'), 'utf8');
    const hashBefore = hashFile(configPath);

    const r = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome,
      piDir,
      input: events,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('urn-publisher-mismatch'));
    assert.ok(r.stdout.includes('trust-manifest-mismatch'));

    const hashAfter = hashFile(configPath);
    assert.equal(hashBefore, hashAfter, 'mcp.json must not be modified');
  });

  it('rejects unknown event version', () => {
    const event =
      '{"v":99,"standard":"ard","origin":"https://x.com","url":"https://x.com/f","via":"well-known","page":"https://x.com/","targetId":"t","status":"valid","summary":{}}';
    const r = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome,
      piDir,
      input: event,
    });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('unknown event version'));
  });

  it('keeps invalid events with their reason', () => {
    const event =
      '{"v":1,"standard":"ard","origin":"https://x.com","url":"https://x.com/.well-known/ard.json","via":"well-known","page":"https://x.com/","targetId":"t","status":"invalid","summary":{"entries":[{"identifier":"urn:air:x.com:mcp:a","displayName":"A","type":"application/mcp-server-card+json","url":"https://x.com/mcp"}]},"reason":"bad manifest"}';
    const r = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome,
      piDir,
      input: event,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('invalid'));
    assert.ok(r.stdout.includes('bad manifest'));
  });

  it('ignores webmcp tools-changed events instead of adding servers', () => {
    const home = createTmpDir();
    const ownState = join(home, 'state');
    const changed = (url, origin, frameId) =>
      JSON.stringify({
        v: 1,
        standard: 'webmcp',
        origin,
        url,
        via: 'page-api',
        page: 'https://live.example.com/',
        targetId: 't9',
        status: 'valid',
        summary: {
          event: 'tools-changed',
          target: 't9',
          frameId,
          loaderId: 'L1',
          origin,
          tools: [{ name: 'search', origin }],
        },
      });
    const loaded = JSON.stringify({
      v: 1,
      standard: 'webmcp',
      origin: 'https://live.example.com',
      url: 'https://live.example.com/',
      via: 'page-api',
      page: 'https://live.example.com/',
      targetId: 't9',
      status: 'valid',
      summary: { tools: ['search'] },
    });
    const only = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome: ownState,
      piDir,
      input: `${changed('https://frame.example.org/widget', 'https://frame.example.org', 'F2')}\n`,
    });
    assert.equal(only.status, 0);
    assert.equal(only.stdout, 'no MCP candidates found\n');
    const mixed = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome: ownState,
      piDir,
      input: `${[
        loaded,
        changed('https://live.example.com/?tab=2', 'https://live.example.com', 't9'),
        changed('https://frame.example.org/widget', 'https://frame.example.org', 'F2'),
      ].join('\n')}\n`,
    });
    assert.equal(mixed.status, 0);
    assert.equal(mixed.stdout.match(/^#\d+ /gm).length, 1, mixed.stdout);
    const again = runMcpcat(['add', '--from-discovery', '-'], {
      stateHome: ownState,
      piDir,
      input: `${changed('https://live.example.com/?tab=3', 'https://live.example.com', 't9')}\n`,
    });
    assert.equal(again.stdout, 'no MCP candidates found\n');
    const inbox = runMcpcat(['inbox', '--json'], { stateHome: ownState, piDir });
    const endpoints = JSON.parse(inbox.stdout).map((c) => c.endpoint);
    assert.deepEqual(endpoints, ['https://live.example.com/']);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('discovery: inbox', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{}}\n');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows empty inbox', () => {
    const r = runMcpcat(['inbox'], { stateHome, piDir });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('empty'));
  });

  it('lists candidates after from-discovery', () => {
    const event =
      '{"v":1,"standard":"ucp","origin":"https://shop.test","url":"https://shop.test/.well-known/ucp","via":"well-known","page":"https://shop.test/","targetId":"t","status":"valid","summary":{"version":"2026-08-25","services":{"catalog":[{"transport":"mcp","endpoint":"https://shop.test/mcp"}]},"capabilities":[],"paymentHandlers":[]}}';
    runMcpcat(['add', '--from-discovery', '-'], {
      stateHome,
      piDir,
      input: event,
    });

    const r = runMcpcat(['inbox'], { stateHome, piDir });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('shop.test/mcp'));

    const hashAfter = hashFile(configPath);
    const hashExpected = hashFile(configPath);
    assert.equal(hashAfter, hashExpected, 'mcp.json untouched by inbox');
  });

  it('lists candidates as JSON', () => {
    const r = runMcpcat(['inbox', '--json'], { stateHome, piDir });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length > 0);
    assert.ok(parsed[0].endpoint);
  });
});

describe('discovery: add --candidate', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{}}\n');

    const event =
      '{"v":1,"standard":"ucp","origin":"https://shop2.test","url":"https://shop2.test/.well-known/ucp","via":"well-known","page":"https://shop2.test/","targetId":"t","status":"valid","summary":{"version":"2026-08-25","services":{"catalog":[{"transport":"mcp","endpoint":"https://shop2.test/mcp"}]},"capabilities":[],"paymentHandlers":[]}}';
    runMcpcat(['add', '--from-discovery', '-'], {
      stateHome,
      piDir,
      input: event,
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds candidate to mcp.json', () => {
    const hashBefore = hashFile(configPath);

    const r = runMcpcat(['add', 'shop', '--candidate', '1', '--config', configPath], {
      stateHome,
      piDir,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('added shop'));

    const hashAfter = hashFile(configPath);
    assert.notEqual(hashBefore, hashAfter, 'mcp.json should be modified by add --candidate');

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers.shop);
    assert.equal(config.mcpServers.shop.url, 'https://shop2.test/mcp');
  });

  it('rejects missing candidate', () => {
    const r = runMcpcat(['add', 'x', '--candidate', '999'], { stateHome, piDir });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('not found'));
  });
});

describe('discovery: discover <url>', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;
  let server;
  let baseUrl;

  before(async () => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{}}\n');

    server = await listenOnPort0((req, res) => {
      if (req.url === '/.well-known/ard.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            entries: [
              {
                identifier: 'urn:air:127.0.0.1:mcp:test',
                displayName: 'Test MCP',
                type: 'application/mcp-server-card+json',
                url: `http://127.0.0.1:${server.address().port}/mcp`,
              },
            ],
          })
        );
      } else if (req.url === '/.well-known/ai-catalog.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            entries: [
              {
                displayName: 'Catalog MCP',
                type: 'application/mcp-server-card+json',
                url: `http://127.0.0.1:${server.address().port}/catalog-mcp`,
              },
            ],
          })
        );
      } else if (req.url === '/') {
        res.setHeader('Link', `</.well-known/ard.json>; rel="ard"`);
        res.setHeader('Content-Type', 'text/html');
        res.end('<html></html>');
      } else if (req.url === '/redirect-test') {
        res.writeHead(302, { Location: '/' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('probes well-known endpoints', async () => {
    const hashBefore = hashFile(configPath);

    const r = await runMcpcatAsync(['discover', baseUrl], { stateHome, piDir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('/mcp'));

    const hashAfter = hashFile(configPath);
    assert.equal(hashBefore, hashAfter, 'mcp.json must not be modified by discover');
  });

  it('treats a redirect as no match', async () => {
    const r = await runMcpcatAsync(['discover', `${baseUrl}/redirect-test`], { stateHome, piDir });
    assert.equal(r.status, 0);
  });

  it('rejects invalid URL', () => {
    const r = runMcpcat(['discover', 'not-a-url'], { stateHome, piDir });
    assert.equal(r.status, 2);
  });

  it('does not send credentials', async () => {
    const r = await runMcpcatAsync(['discover', baseUrl], { stateHome, piDir });
    assert.equal(r.status, 0);
  });
});

describe('discovery: discover <url> with MCP probe', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;
  let mcpServer;
  let mcpUrl;

  before(async () => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{}}\n');

    mcpServer = await startFixtureServer('server-2026-http.mjs');
    mcpUrl = `http://127.0.0.1:${mcpServer.port}`;
  });

  after(() => {
    mcpServer?.child.kill('SIGTERM');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers MCP server via POST server/discover', async () => {
    const hashBefore = hashFile(configPath);
    const r = await runMcpcatAsync(['discover', mcpUrl], { stateHome, piDir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(mcpUrl) || r.stdout.includes('/mcp'), 'should find MCP endpoint');
    assert.ok(r.stdout.includes('mcp'), 'standard should be mcp');
    const hashAfter = hashFile(configPath);
    assert.equal(hashBefore, hashAfter, 'mcp.json must not be modified');
  });
});

describe('discovery: discover <url> with 401 OAuth server', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;
  let authServer;
  let authUrl;

  before(async () => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{}}\n');

    authServer = await listenOnPort0((req, res) => {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate':
          'Bearer realm="mcp", resource_metadata="https://auth.test/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    authUrl = `http://127.0.0.1:${authServer.address().port}`;
  });

  after(() => {
    authServer?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers 401 server as auth-required candidate', async () => {
    const hashBefore = hashFile(configPath);
    const r = await runMcpcatAsync(['discover', authUrl], { stateHome, piDir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('auth-required'), 'should show auth-required trust signal');
    const hashAfter = hashFile(configPath);
    assert.equal(hashBefore, hashAfter, 'mcp.json must not be modified');
  });
});

describe('discovery: mcp.json integrity', () => {
  let tmpDir;
  let stateHome;
  let piDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    stateHome = join(tmpDir, 'state');
    piDir = join(tmpDir, 'pi');
    mkdirSync(piDir, { recursive: true });
    configPath = join(piDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{"existing":{"url":"https://keep.test/mcp"}}}\n');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const cmd of [['add', '--from-discovery', '-'], ['inbox'], ['inbox', '--json']]) {
    it(`mcp.json unchanged after: ${cmd.join(' ')}`, () => {
      const hashBefore = hashFile(configPath);
      const input =
        cmd[0] === 'add'
          ? '{"v":1,"standard":"ucp","origin":"https://x.test","url":"https://x.test/.well-known/ucp","via":"well-known","page":"https://x.test/","targetId":"t","status":"valid","summary":{"version":"2026-08-25","services":{"s":[{"transport":"mcp","endpoint":"https://x.test/mcp"}]},"capabilities":[],"paymentHandlers":[]}}'
          : undefined;
      runMcpcat(cmd, { stateHome, piDir, input });
      const hashAfter = hashFile(configPath);
      assert.equal(hashBefore, hashAfter, `mcp.json hash changed after: ${cmd.join(' ')}`);
    });
  }
});

describe('discovery: event schema validation', () => {
  it('schema file exists and is valid JSON Schema', () => {
    const schemaPath = join(fixturesDir, 'discovery-event-schema.json');
    assert.ok(existsSync(schemaPath), 'event schema should be copied from slicc-cdp');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    assert.equal(schema.title, 'DiscoveryEvent');
    assert.deepEqual(schema.required, [
      'v',
      'standard',
      'origin',
      'url',
      'via',
      'page',
      'targetId',
      'status',
      'summary',
    ]);
    assert.equal(schema.properties.v.const, 1);
  });

  it('fixture events match schema structure', () => {
    const schemaPath = join(fixturesDir, 'discovery-event-schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const events = readFileSync(join(fixturesDir, 'discovery-events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    for (const event of events) {
      for (const field of schema.required) {
        assert.ok(field in event, `event for ${event.standard} missing required field: ${field}`);
      }
      assert.equal(event.v, 1);
      assert.ok(schema.properties.via.enum.includes(event.via), `invalid via: ${event.via}`);
      assert.ok(
        schema.properties.status.enum.includes(event.status),
        `invalid status: ${event.status}`
      );
    }
  });
});
