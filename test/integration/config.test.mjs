import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

function createTmpDir() {
  const dir = join(tmpdir(), `mcpcat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runMcpcat(args, options = {}) {
  try {
    const result = execFileSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: options.home || process.env.HOME,
      },
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

describe('config: round-trip preservation', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    configPath = join(tmpDir, 'mcp.json');
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves unknown keys byte-for-byte outside the touched entry', () => {
    const fixture = readFileSync(join(fixturesDir, 'pi-mcp.json'), 'utf8');
    writeFileSync(configPath, fixture);

    runMcpcat([
      'add',
      '--no-probe',
      'new-server',
      'https://new.example.com/mcp',
      '--config',
      configPath,
    ]);

    const afterAdd = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(afterAdd);
    assert.equal(parsed.mcpServers['new-server'].url, 'https://new.example.com/mcp');
    assert.equal(parsed.customKey, 'pi wrote this');
    assert.deepEqual(parsed.nested, { deep: [1, 2, 3] });
    assert.equal(parsed.autoEnableCodemode, true);
    assert.equal(parsed.mcpServers.docs.url, 'https://example.com/mcp');
    assert.equal(parsed.mcpServers.docs.headers.Authorization, 'Bearer ${DOCS_TOKEN}');
    assert.equal(parsed.mcpServers.fs.command, 'npx');
    assert.equal(parsed.mcpServers.time.enabled, false);

    runMcpcat(['rm', 'new-server', '--config', configPath]);

    const afterRm = readFileSync(configPath, 'utf8');
    const parsedAfterRm = JSON.parse(afterRm);
    assert.equal(parsedAfterRm.mcpServers['new-server'], undefined);
    assert.equal(parsedAfterRm.customKey, 'pi wrote this');
    assert.deepEqual(parsedAfterRm.nested, { deep: [1, 2, 3] });
    assert.equal(parsedAfterRm.mcpServers.docs.url, 'https://example.com/mcp');
  });
});

describe('config: add verb', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    configPath = join(tmpDir, 'mcp.json');
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds an HTTP server', () => {
    const { status, stdout } = runMcpcat([
      'add',
      '--no-probe',
      'docs',
      'https://example.com/mcp',
      '-H',
      'Authorization: Bearer ${TOKEN}',
      '--description',
      'Product docs',
      '--config',
      configPath,
    ]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('added docs'));

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.docs.url, 'https://example.com/mcp');
    assert.equal(written.mcpServers.docs.headers.Authorization, 'Bearer ${TOKEN}');
    assert.equal(written.mcpServers.docs.description, 'Product docs');
  });

  it('adds a stdio server with -- syntax', () => {
    const { status } = runMcpcat([
      'add',
      '--no-probe',
      'fs',
      '--config',
      configPath,
      '--',
      'npx',
      '-y',
      '@mcp/server-fs',
      '.',
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.fs.command, 'npx');
    assert.deepEqual(written.mcpServers.fs.args, ['-y', '@mcp/server-fs', '.']);
  });

  it('accepts six order (url first, name second)', () => {
    const { status } = runMcpcat([
      'add',
      '--no-probe',
      'https://example.com/mcp',
      'six-style',
      '--config',
      configPath,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers['six-style'].url, 'https://example.com/mcp');
  });

  it('refuses literal secrets in URLs', () => {
    const { status, stderr } = runMcpcat([
      'add',
      '--no-probe',
      'bad',
      'https://user:pass@example.com/mcp',
      '--config',
      configPath,
    ]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('literal secret'));
  });

  it('refuses literal secrets in headers', () => {
    const { status, stderr } = runMcpcat([
      'add',
      '--no-probe',
      'bad',
      'https://example.com/mcp',
      '-H',
      'Authorization: Bearer actualtoken123',
      '--config',
      configPath,
    ]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('literal secret'));
  });
});

describe('config: rm verb', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    configPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { x: { url: 'https://x.com/mcp' } } }, null, 2)
    );
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes a server', () => {
    const { status } = runMcpcat(['rm', 'x', '--config', configPath]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.x, undefined);
  });

  it('exits 1 for missing server', () => {
    const { status } = runMcpcat(['rm', 'nonexistent', '--config', configPath]);
    assert.equal(status, 1);
  });
});

describe('config: list verb', () => {
  it('lists servers from a config file', () => {
    const { status, stdout } = runMcpcat(['list', '--config', join(fixturesDir, 'pi-mcp.json')]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('docs'));
    assert.ok(stdout.includes('fs'));
    assert.ok(stdout.includes('time'));
    assert.ok(stdout.includes('sentry'));
  });

  it('lists servers as JSON', () => {
    const { status, stdout } = runMcpcat([
      'list',
      '--json',
      '--config',
      join(fixturesDir, 'pi-mcp.json'),
    ]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.docs);
    assert.equal(parsed.docs.url, 'https://example.com/mcp');
  });

  it('prints "no servers configured" for empty config', () => {
    const tmpDir = createTmpDir();
    const emptyConfig = join(tmpDir, 'mcp.json');
    writeFileSync(emptyConfig, JSON.stringify({ mcpServers: {} }));
    const { status, stdout } = runMcpcat(['list', '--config', emptyConfig]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('no servers configured'));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('config: enable/disable verbs', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    configPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { x: { url: 'https://x.com/mcp' } } }, null, 2)
    );
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('disables a server', () => {
    const { status } = runMcpcat(['disable', 'x', '--config', configPath]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.x.enabled, false);
  });

  it('enables a server', () => {
    const { status } = runMcpcat(['enable', 'x', '--config', configPath]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.x.enabled, true);
  });
});

describe('config: exposure verb', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    configPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { x: { url: 'https://x.com/mcp' } } }, null, 2)
    );
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets server exposure', () => {
    const { status } = runMcpcat(['exposure', 'x', 'direct', '--config', configPath]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.x.exposure, 'direct');
  });

  it('sets per-tool exposure', () => {
    const { status } = runMcpcat([
      'exposure',
      'x',
      'hidden',
      '--tool',
      'delete_*',
      '--config',
      configPath,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.mcpServers.x.toolExposure['delete_*'], 'hidden');
  });

  it('rejects invalid mode', () => {
    const { status } = runMcpcat(['exposure', 'x', 'bogus', '--config', configPath]);
    assert.equal(status, 2);
  });
});

describe('config: import verb', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    configPath = join(tmpDir, 'mcp.json');
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports from Claude/pi format', () => {
    const { status } = runMcpcat([
      'import',
      join(fixturesDir, 'pi-mcp.json'),
      '--config',
      configPath,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(written.mcpServers.docs);
    assert.ok(written.mcpServers.fs);
  });

  it('imports from six servers.json', () => {
    const newConfig = join(tmpDir, 'six-import.json');
    const { status } = runMcpcat([
      'import',
      join(fixturesDir, 'six-servers.json'),
      '--config',
      newConfig,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(newConfig, 'utf8'));
    assert.ok(written.mcpServers.github);
    assert.equal(written.mcpServers.github.url, 'https://api.githubcopilot.com/mcp/');
  });

  it('imports from VS Code format', () => {
    const newConfig = join(tmpDir, 'vscode-import.json');
    const { status } = runMcpcat([
      'import',
      join(fixturesDir, 'vscode-mcp.json'),
      '--config',
      newConfig,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(newConfig, 'utf8'));
    assert.ok(written.mcpServers.myserver);
    assert.equal(written.mcpServers.myserver.env.API_KEY, '${APIKEY}');
  });

  it('imports from Codex TOML', () => {
    const newConfig = join(tmpDir, 'codex-import.json');
    const { status } = runMcpcat([
      'import',
      join(fixturesDir, 'codex-config.toml'),
      '--config',
      newConfig,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(newConfig, 'utf8'));
    assert.ok(written.mcpServers.github);
    assert.equal(written.mcpServers.github.command, 'npx');
  });

  it('imports selected names only', () => {
    const newConfig = join(tmpDir, 'selective-import.json');
    const { status } = runMcpcat([
      'import',
      join(fixturesDir, 'pi-mcp.json'),
      'docs',
      '--config',
      newConfig,
    ]);
    assert.equal(status, 0);
    const written = JSON.parse(readFileSync(newConfig, 'utf8'));
    assert.ok(written.mcpServers.docs);
    assert.equal(written.mcpServers.fs, undefined);
  });
});

describe('config: project trust rule', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('project stdio entry is not listed without --trust-project', () => {
    const userConfig = join(tmpDir, 'user-mcp.json');
    writeFileSync(
      userConfig,
      JSON.stringify({ mcpServers: { global: { url: 'https://g.com/mcp' } } })
    );

    const projectDir = join(tmpDir, 'project');
    mkdirSync(join(projectDir, '.pi'), { recursive: true });
    writeFileSync(
      join(projectDir, '.pi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          untrusted: { command: 'evil-cmd', args: ['--steal'] },
        },
      })
    );

    const withoutTrust = runMcpcat(['list', '--json', '--config', userConfig], {
      cwd: projectDir,
    });
    assert.equal(withoutTrust.status, 0);
    const servers = JSON.parse(withoutTrust.stdout);
    assert.ok(servers.global, 'user server should be listed');
    assert.equal(servers.untrusted, undefined, 'project server must not appear without trust');
  });
});
