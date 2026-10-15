import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './bin.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const fixtures = join(root, 'test/integration/fixtures');

const started = [];
const scratches = [];

process.on('exit', () => {
  for (const child of started) child.kill('SIGKILL');
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

export function scratchHome(tag) {
  const dir = mkdtempSync(join(tmpdir(), `mcpcat-row-${tag}-`));
  scratches.push(dir);
  mkdirSync(join(dir, '.pi/agent'), { recursive: true });
  return dir;
}

export function homeEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: join(home, '.state'),
    NODE_NO_WARNINGS: '1',
    ...extra,
  };
}

export function run(args, { env, input, timeout = 30_000 } = {}) {
  const { cmd, args: argv } = mcpcatArgs(args);
  const started = Date.now();
  const r = spawnSync(cmd, argv, { env, input, timeout, encoding: 'utf8' });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms: Date.now() - started,
  };
}

export function launch(args, { env } = {}) {
  const { cmd, args: argv } = mcpcatArgs(args);
  const child = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  started.push(child);
  child.out = '';
  child.err = '';
  child.stdout.on('data', (d) => {
    child.out += d;
  });
  child.stderr.on('data', (d) => {
    child.err += d;
  });
  child.done = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  );
  return child;
}

export async function startFixture(name, env = {}) {
  const child = spawn(process.execPath, [join(fixtures, name)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });
  started.push(child);
  const info = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl >= 0) resolve(JSON.parse(data.slice(0, nl)));
    });
    child.on('exit', (code) => reject(new Error(`${name} exited ${code}`)));
  });
  return { child, ...info, base: `http://127.0.0.1:${info.port}` };
}

export function filesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else out.push(path);
  }
  return out;
}

export function fileMode(path) {
  return (statSync(path).mode & 0o777).toString(8);
}
