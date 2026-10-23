import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const development = version === '0.0.0';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const refusal =
  'releases are fetched over https, or plain http only from 127.0.0.1, ::1 or localhost';
const scratch = mkdtempSync(join(tmpdir(), 'mcpcat-upgrade-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

let packs = 0;
function tarball(files) {
  const dir = join(scratch, `pack-${++packs}`);
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'package', name)), { recursive: true });
    writeFileSync(join(dir, 'package', name), data);
  }
  const out = join(dir, 'out.tgz');
  const r = spawnSync('tar', ['czf', out, '-C', dir, 'package']);
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(out);
}

const script = (body) =>
  tarball({
    'package.json': '{"name":"@ai-ecoverse/mcpcat","version":"9.9.9"}\n',
    'dist/host/mcpcat.mjs': body,
  });
const reports = (reported) => script(`console.log(${JSON.stringify(reported)});\n`);

function realRelease() {
  const dir = join(scratch, `real-${++packs}`);
  mkdirSync(join(dir, 'package'), { recursive: true });
  cpSync(join(root, 'dist'), join(dir, 'package/dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package/package.json'));
  const out = join(dir, 'out.tgz');
  const r = spawnSync('tar', ['czf', out, '-C', dir, 'package']);
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(out);
}

function fakeGitHub() {
  const state = {};
  const reset = () =>
    Object.assign(state, {
      tag: 'v9.9.9',
      payload: reports('9.9.9'),
      sums: null,
      assetUrl: null,
      sumsUrl: null,
      status: 200,
      downloads: 0,
      requests: [],
    });
  reset();
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, agent: req.headers['user-agent'] });
    if (state.status !== 200) {
      res.writeHead(state.status).end('unavailable');
      return;
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    const asset = `mcpcat-${state.tag.slice(1)}.tgz`;
    if (req.url === '/repos/ai-ecoverse/mcpcat/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: state.tag,
          assets: [
            { name: 'install.sh', browser_download_url: `${base}/dl/install.sh` },
            { name: asset, browser_download_url: state.assetUrl ?? `${base}/dl/${asset}` },
            { name: 'SHA256SUMS', browser_download_url: state.sumsUrl ?? `${base}/dl/SHA256SUMS` },
          ],
        })
      );
      return;
    }
    if (req.url === '/dl/away') {
      res.writeHead(302, { location: `http://downloads.example.com/objects/${asset}` }).end();
      return;
    }
    if (req.url === `/dl/${asset}`) {
      res.writeHead(302, { location: `/objects/${asset}` }).end();
      return;
    }
    if (req.url === `/objects/${asset}`) {
      state.downloads += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(state.payload);
      return;
    }
    if (req.url === '/dl/SHA256SUMS') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(state.sums ?? `${sha256(state.payload)}  ${asset}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ state, reset, server, base: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

let installs = 0;
function install() {
  const dir = realpathSync(mkdtempSync(join(scratch, `install-${++installs}-`)));
  const data = join(dir, 'share/mcpcat');
  const bundle = join(data, version);
  mkdirSync(bundle, { recursive: true });
  cpSync(join(root, 'dist'), join(bundle, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(bundle, 'package.json'));
  symlinkSync(version, join(data, 'current'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const launcher = join(bin, 'mcpcat');
  const text = `#!/bin/sh\nexec "${process.execPath}" "${join(bundle, 'dist/host/mcpcat.mjs')}" "$@"\n`;
  writeFileSync(launcher, text, { mode: 0o755 });
  return { dir, data, bin, launcher, text };
}

function untouched(inst) {
  assert.equal(readFileSync(inst.launcher, 'utf8'), inst.text);
  assert.deepEqual(readdirSync(inst.bin), ['mcpcat']);
  assert.deepEqual(readdirSync(inst.data).sort(), [version, 'current'].sort());
  assert.equal(readlinkSync(join(inst.data, 'current')), version);
}

function run(cmd, args, base, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MCPCAT_UPDATE_API_BASE: base };
    delete env.INSTALL_DIR;
    if (base === null) delete env.MCPCAT_UPDATE_API_BASE;
    Object.assign(env, extra);
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('mcpcat upgrade replaces an install.sh install with the verified latest release', async (t) => {
  const fake = await fakeGitHub();
  t.after(() => fake.server.close());
  const notice = (command = 'upgrade', base = fake.base) =>
    `mcpcat ${command}: MCPCAT_UPDATE_API_BASE overrides the GitHub API with ${base}\n`;
  const after = (result, command = 'upgrade', base = fake.base) => {
    assert.ok(result.stderr.startsWith(notice(command, base)), result.stderr);
    return result.stderr.slice(notice(command, base).length);
  };
  const go = (inst, args, base = fake.base, extra = {}) =>
    run(inst.launcher, args, base, {
      PATH: `${inst.bin}${delimiter}${process.env.PATH}`,
      ...extra,
    });

  await t.test('--check reports the latest release and changes nothing', async () => {
    fake.reset();
    const inst = install();
    const result = await go(inst, ['upgrade', '--check']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, notice());
    assert.equal(
      result.stdout,
      development
        ? `latest release: 9.9.9 (this is a development build, ${version})\n`
        : `mcpcat 9.9.9 is available (you have ${version}); run \`mcpcat upgrade\`\n`
    );
    assert.equal(fake.state.downloads, 0);
    assert.equal(fake.state.requests.length, 1);
    assert.match(fake.state.requests[0].agent, /^mcpcat\//);
    untouched(inst);
  });

  await t.test('leading global options still reach upgrade and update', async () => {
    fake.reset();
    const inst = install();
    const want = development
      ? `latest release: 9.9.9 (this is a development build, ${version})\n`
      : `mcpcat 9.9.9 is available (you have ${version}); run \`mcpcat upgrade\`\n`;
    for (const args of [
      ['-v', 'upgrade', '--check'],
      ['--silent', 'update', '--check'],
      ['-m', '5', '--json', 'upgrade', '--check'],
    ]) {
      const command = args.find((arg) => arg === 'upgrade' || arg === 'update');
      const result = await go(inst, args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, notice(command));
      assert.equal(result.stdout, want);
    }
    for (const flag of ['--help', '-h']) {
      for (const command of ['upgrade', 'update']) {
        const global = await go(inst, [flag, command]);
        assert.equal(global.code, 0, global.stderr);
        assert.equal(global.stderr, '');
        assert.match(global.stdout, /^mcpcat \S+ – a curl for the Model Context Protocol\n/);
      }
    }
    for (const flag of ['--version', '-V']) {
      for (const args of [
        [flag, 'upgrade'],
        ['-v', flag, 'update', '--force'],
      ]) {
        const shown = await go(inst, args);
        assert.equal(shown.code, 0, shown.stderr);
        assert.equal(shown.stderr, '');
        assert.equal(shown.stdout, `${version}\n`);
      }
    }
    const help = await go(inst, ['--silent', 'update', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^mcpcat update \[--check\] \[--force\]\n/);
    assert.equal(fake.state.downloads, 0);
    assert.equal(fake.state.requests.length, 3);
    untouched(inst);
  });

  await t.test('upgrade options before the verb apply, and unknown ones are refused', async () => {
    fake.reset();
    const inst = install();
    const want = development
      ? `latest release: 9.9.9 (this is a development build, ${version})\n`
      : `mcpcat 9.9.9 is available (you have ${version}); run \`mcpcat upgrade\`\n`;
    for (const args of [
      ['--check', 'upgrade'],
      ['--check', 'update', '--force'],
      ['--force', '-v', '--check', 'upgrade'],
    ]) {
      const command = args.find((arg) => arg === 'upgrade' || arg === 'update');
      const result = await go(inst, args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, notice(command));
      assert.equal(result.stdout, want);
    }
    assert.equal(fake.state.downloads, 0);
    assert.equal(fake.state.requests.length, 3);
    for (const args of [
      ['--bogus', 'upgrade', '--check'],
      ['-v', '--nope', 'update'],
    ]) {
      const command = args.find((arg) => arg === 'upgrade' || arg === 'update');
      const result = await go(inst, args);
      assert.equal(result.code, 2);
      assert.match(
        result.stderr,
        new RegExp(`^mcpcat ${command}: unknown option ${args[args.indexOf(command) - 1]}\\n`)
      );
    }
    assert.equal(fake.state.requests.length, 3);
    untouched(inst);
  });

  await t.test(
    'a development build is not replaced without --force',
    { skip: development ? false : 'this build has a release version' },
    async () => {
      fake.reset();
      const inst = install();
      const result = await go(inst, ['upgrade']);
      assert.equal(result.code, 1);
      assert.equal(
        after(result),
        `mcpcat upgrade: refusing to replace a development build (${version}) with release 9.9.9; pass --force to replace it\n`
      );
      assert.equal(fake.state.downloads, 0);
      untouched(inst);
    }
  );

  await t.test('update is an alias that downloads through a redirect and swaps', async () => {
    fake.reset();
    const inst = install();
    const result = await go(inst, ['update', '--force']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, notice('update'));
    assert.equal(
      result.stdout,
      `upgrading mcpcat ${version} to 9.9.9\nupgraded ${inst.launcher} to mcpcat 9.9.9 (SHA256SUMS verified)\n`
    );
    assert.equal(fake.state.downloads, 1);
    assert.equal(
      readFileSync(inst.launcher, 'utf8'),
      `#!/bin/sh\nexec "${process.execPath}" "${join(inst.data, '9.9.9/dist/host/mcpcat.mjs')}" "$@"\n`
    );
    assert.deepEqual(readdirSync(inst.bin), ['mcpcat']);
    assert.deepEqual(readdirSync(inst.data).sort(), ['9.9.9', 'current']);
    assert.equal(readlinkSync(join(inst.data, 'current')), '9.9.9');
    const swapped = await go(inst, ['--version'], null);
    assert.equal(swapped.stdout, '9.9.9\n');
    assert.equal(swapped.stderr, '');
  });

  await t.test('a real release reinstalls the same version through the version gate', async () => {
    fake.reset();
    fake.state.tag = `v${version}`;
    fake.state.payload = realRelease();
    const inst = install();
    const result = await go(inst, ['upgrade', '--force']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.downloads, 1);
    untouched(inst);
    const again = await go(inst, ['--version'], null);
    assert.equal(again.stdout, `${version}\n`);
  });

  await t.test('a checksum mismatch replaces nothing', async () => {
    fake.reset();
    fake.state.sums = `${'ab'.repeat(32)}  mcpcat-9.9.9.tgz\n`;
    const inst = install();
    const result = await go(inst, ['upgrade', '--force']);
    assert.equal(result.code, 1);
    assert.equal(
      after(result),
      'mcpcat upgrade: mcpcat-9.9.9.tgz does not match its SHA-256 in SHA256SUMS\n'
    );
    untouched(inst);
  });

  await t.test('a tarball missing from SHA256SUMS is refused before it is downloaded', async () => {
    fake.reset();
    fake.state.sums = `${'0'.repeat(64)}  install.sh\n`;
    const inst = install();
    const result = await go(inst, ['upgrade', '--force']);
    assert.equal(result.code, 1);
    assert.equal(after(result), 'mcpcat upgrade: SHA256SUMS has no entry for mcpcat-9.9.9.tgz\n');
    assert.equal(fake.state.downloads, 0);
    untouched(inst);
  });

  await t.test('a release that reports another version replaces nothing', async () => {
    fake.reset();
    fake.state.payload = reports('9.9.8');
    const inst = install();
    const result = await go(inst, ['upgrade', '--force']);
    assert.equal(result.code, 1);
    assert.equal(
      after(result),
      'mcpcat upgrade: the downloaded mcpcat reports "9.9.8", expected "9.9.9"\n'
    );
    untouched(inst);
  });

  await t.test('a release that does not run replaces nothing', async () => {
    fake.reset();
    fake.state.payload = script('process.exit(3);\n');
    const inst = install();
    const result = await go(inst, ['upgrade', '--force']);
    assert.equal(result.code, 1);
    assert.equal(
      after(result),
      'mcpcat upgrade: the downloaded mcpcat failed to run --version (exit 3)\n'
    );
    untouched(inst);
    fake.reset();
    fake.state.payload = Buffer.from('not a tarball');
    const broken = await go(inst, ['upgrade', '--force']);
    assert.equal(broken.code, 1);
    assert.match(after(broken), /^mcpcat upgrade: unpacking mcpcat-9\.9\.9\.tgz: /);
    untouched(inst);
  });

  await t.test(
    'an unwritable launcher, directory or install is not downloaded or replaced',
    { skip: process.getuid?.() === 0 ? 'root can write anything' : false },
    async () => {
      fake.reset();
      const inst = install();
      chmodSync(inst.launcher, 0o555);
      const file = await go(inst, ['upgrade', '--force']);
      assert.equal(file.code, 1);
      assert.equal(
        after(file),
        `mcpcat upgrade: ${inst.launcher} is not writable; rerun with permission to write it, or reinstall with install.sh\n`
      );
      chmodSync(inst.launcher, 0o755);
      chmodSync(inst.bin, 0o555);
      try {
        const dir = await go(inst, ['upgrade', '--force']);
        assert.equal(dir.code, 1);
        assert.equal(
          after(dir),
          `mcpcat upgrade: ${inst.bin} is not writable, so ${inst.launcher} can't be replaced; rerun with permission to write it, or reinstall with install.sh\n`
        );
      } finally {
        chmodSync(inst.bin, 0o755);
      }
      chmodSync(inst.data, 0o555);
      try {
        const data = await go(inst, ['upgrade', '--force']);
        assert.equal(data.code, 1);
        assert.match(
          after(data),
          /^mcpcat upgrade: .* is not writable, so the new release can't be unpacked beside /
        );
      } finally {
        chmodSync(inst.data, 0o755);
      }
      assert.equal(fake.state.downloads, 0);
      assert.ok(fake.state.requests.every((r) => r.url.startsWith('/repos/')));
      untouched(inst);
      chmodSync(inst.bin, 0o555);
      try {
        const check = await go(inst, ['upgrade', '--check']);
        assert.equal(check.code, 0, check.stderr);
      } finally {
        chmodSync(inst.bin, 0o755);
      }
    }
  );

  await t.test('a launcher that is not on PATH is not guessed', async () => {
    fake.reset();
    const inst = install();
    const result = await run(inst.launcher, ['upgrade', '--force'], fake.base);
    assert.equal(result.code, 1);
    assert.match(after(result), /can't find the launcher install\.sh wrote for /);
    assert.equal(fake.state.downloads, 0);
    untouched(inst);
    const named = await run(inst.launcher, ['upgrade', '--force'], fake.base, {
      INSTALL_DIR: inst.bin,
    });
    assert.equal(named.code, 0, named.stderr);
  });

  await t.test('npm, npx, pnpm, git and unknown installs are left alone', async () => {
    fake.reset();
    const place = (...segments) => {
      const dir = join(scratch, `managed-${++installs}`, ...segments);
      mkdirSync(dir, { recursive: true });
      cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
      return join(dir, 'dist/host/mcpcat.mjs');
    };
    const cases = [
      [
        place('lib/node_modules/@ai-ecoverse/mcpcat'),
        'mcpcat upgrade: mcpcat was installed with npm; update it with `npm i -g @ai-ecoverse/mcpcat`, or with `npm i @ai-ecoverse/mcpcat@latest` in the project that depends on it\n',
      ],
      [
        place('_npx/abc/node_modules/@ai-ecoverse/mcpcat'),
        'mcpcat upgrade: mcpcat runs from npx; run `npx @ai-ecoverse/mcpcat@latest` for the latest\n',
      ],
      [
        place('pnpm/global/5/.pnpm/mcpcat/node_modules/@ai-ecoverse/mcpcat'),
        'mcpcat upgrade: mcpcat was installed with pnpm; update it with `pnpm add -g @ai-ecoverse/mcpcat@latest`\n',
      ],
      [
        join(root, 'dist/host/mcpcat.mjs'),
        `mcpcat upgrade: mcpcat runs from a git checkout (${realpathSync(root)}); update it with \`git pull && npm install\`\n`,
      ],
      [place('opt/mcpcat'), null],
    ];
    for (const [entry, advice] of cases) {
      for (const base of [fake.base, null]) {
        const result = await run(process.execPath, [entry, 'upgrade'], base);
        assert.equal(result.code, 1, result.stderr);
        const text = base === null ? result.stderr : after(result);
        if (advice) assert.equal(text, advice);
        else
          assert.match(
            text,
            /^mcpcat upgrade: mcpcat in .*opt\/mcpcat was not installed by install\.sh; reinstall it with `curl -fsSL https:\/\/get\.sliccy\.ai\/mcpcat \| sh`\n$/
          );
      }
    }
    assert.ok(existsSync(join(root, '.git')));
    assert.equal(fake.state.requests.length, 0);
  });

  await t.test('a non-loopback http API base is refused before it is dialled', async () => {
    fake.reset();
    const inst = install();
    const base = 'http://api.example.com';
    const result = await go(inst, ['upgrade', '--check'], base);
    assert.equal(result.code, 1);
    assert.equal(
      after(result, 'upgrade', base),
      `mcpcat upgrade: asking GitHub for the latest release: refusing http://api.example.com: ${refusal}\n`
    );
    untouched(inst);
  });

  await t.test('http download URLs and redirects to another host are refused', async () => {
    fake.reset();
    fake.state.assetUrl = 'http://downloads.example.com/dl/mcpcat-9.9.9.tgz';
    const inst = install();
    const asset = await go(inst, ['upgrade', '--force']);
    assert.equal(asset.code, 1);
    assert.equal(
      after(asset),
      `mcpcat upgrade: downloading mcpcat-9.9.9.tgz: refusing http://downloads.example.com: ${refusal}\n`
    );
    fake.reset();
    fake.state.sumsUrl = 'http://downloads.example.com/dl/SHA256SUMS';
    const sums = await go(inst, ['update', '--force']);
    assert.equal(sums.code, 1);
    assert.equal(
      after(sums, 'update'),
      `mcpcat update: downloading SHA256SUMS: refusing http://downloads.example.com: ${refusal}\n`
    );
    fake.reset();
    fake.state.assetUrl = `${fake.base}/dl/away`;
    const redirect = await go(inst, ['upgrade', '--force']);
    assert.equal(redirect.code, 1);
    assert.equal(
      after(redirect),
      `mcpcat upgrade: downloading mcpcat-9.9.9.tgz: refusing http://downloads.example.com: ${refusal}\n`
    );
    assert.equal(fake.state.downloads, 0);
    untouched(inst);
  });

  await t.test('a GitHub API failure is reported', async () => {
    fake.reset();
    fake.state.status = 403;
    const inst = install();
    const result = await go(inst, ['upgrade', '--check']);
    assert.equal(result.code, 1);
    assert.equal(after(result), 'mcpcat upgrade: asking GitHub for the latest release: HTTP 403\n');
    untouched(inst);
  });

  await t.test(
    'unknown options and arguments are refused, and help documents both names',
    async () => {
      fake.reset();
      const inst = install();
      const option = await go(inst, ['upgrade', '--nope']);
      assert.equal(option.code, 2);
      assert.match(option.stderr, /^mcpcat upgrade: unknown option --nope\n/);
      const argument = await go(inst, ['update', 'now']);
      assert.equal(argument.code, 2);
      assert.match(argument.stderr, /^mcpcat update: unexpected argument 'now'\n/);
      for (const name of ['upgrade', 'update']) {
        for (const args of [
          [name, '--help'],
          ['help', name],
        ]) {
          const help = await go(inst, args);
          assert.equal(help.code, 0);
          assert.match(help.stdout, new RegExp(`^mcpcat ${name} \\[--check\\] \\[--force\\]\\n`));
        }
      }
      const global = await go(inst, ['--help']);
      assert.match(
        global.stdout,
        /upgrade \[--check\] \[--force\]\n +Replace this install\.sh install/
      );
      assert.match(global.stdout, /alias: update; not in the kernel/);
      assert.equal(fake.state.requests.length, 0);
      untouched(inst);
    }
  );
});
