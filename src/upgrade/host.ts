import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '../platform/types.ts';
import {
  allowedUrl,
  INSTALLER,
  isReleaseVersion,
  launcherText,
  managedBy,
  normalizeVersion,
  parseChecksums,
  parseLauncher,
  plan,
  SUMS,
  UPGRADE_API_ENV,
  UPGRADE_REPO,
  type UpgradeRequest,
} from './plan.ts';

const DEFAULT_API = 'https://api.github.com';
const MAX_JSON = 4 << 20;
const MAX_SUMS = 1 << 20;
const MAX_TARBALL = 256 << 20;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const VERIFY_MS = 30_000;

class UpgradeError extends Error {}

export const ops = { rename, symlink, writeFile };

interface Release {
  version: string;
  asset: string;
  assetUrl: string;
  sumsUrl: string;
}

interface Install {
  dataDir: string;
  bundleDir: string;
  entry: string;
}

interface Launcher {
  path: string;
  node: string;
}

export interface UpgradeOptions {
  entry?: string;
  verifyMs?: number;
}

function causeOf(err: unknown): string {
  const cause = (err as { cause?: { message?: string } }).cause;
  return cause?.message ?? (err as Error).message;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > cap) {
        await Promise.allSettled([res.body.cancel()]);
        throw new UpgradeError(`larger than ${cap} bytes`);
      }
      chunks.push(chunk);
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function get(
  platform: Platform,
  url: string,
  agent: string,
  accept: string | undefined,
  cap: number,
  ms: number
): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const from = allowedUrl(current);
    const headers: Record<string, string> = { 'user-agent': agent };
    if (accept) headers.accept = accept;
    let res: Response;
    try {
      res = await platform.fetch(current, {
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      throw new UpgradeError(causeOf(err));
    }
    if (res.status === 200) return readCapped(res, cap);
    await Promise.allSettled([res.body?.cancel()]);
    if (!REDIRECTS.has(res.status)) throw new UpgradeError(`HTTP ${res.status}`);
    const location = res.headers.get('location');
    if (!location) throw new UpgradeError(`HTTP ${res.status} without a Location`);
    const next = new URL(location, current);
    if (from.protocol === 'https:' && next.protocol !== 'https:') {
      throw new UpgradeError(`refusing a redirect from https to ${next.protocol.slice(0, -1)}`);
    }
    current = next.href;
  }
  throw new UpgradeError(`more than ${MAX_REDIRECTS} redirects`);
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new UpgradeError(`${label}: ${(err as Error).message}`);
  }
}

interface GithubRelease {
  tag_name?: unknown;
  assets?: { name?: unknown; browser_download_url?: unknown }[];
}

async function latest(platform: Platform, base: string, agent: string): Promise<Release> {
  const label = 'asking GitHub for the latest release';
  const body = await step(label, () =>
    get(
      platform,
      `${base}/repos/${UPGRADE_REPO}/releases/latest`,
      agent,
      'application/vnd.github+json',
      MAX_JSON,
      60_000
    )
  );
  const json = await step(label, async () => JSON.parse(new TextDecoder().decode(body)));
  const release = (json ?? {}) as GithubRelease;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!isReleaseVersion(tag)) {
    throw new UpgradeError(`the latest release has an unexpected tag ${JSON.stringify(tag)}`);
  }
  const version = normalizeVersion(tag);
  const asset = `mcpcat-${version}.tgz`;
  let assetUrl: string | undefined;
  let sumsUrl: string | undefined;
  for (const entry of Array.isArray(release.assets) ? release.assets : []) {
    const link = typeof entry?.browser_download_url === 'string' ? entry.browser_download_url : '';
    if (entry?.name === asset) assetUrl = link;
    else if (entry?.name === SUMS) sumsUrl = link;
  }
  if (!assetUrl) throw new UpgradeError(`release ${version} has no ${asset}`);
  if (!sumsUrl) throw new UpgradeError(`release ${version} has no ${SUMS}`);
  return { version, asset, assetUrl, sumsUrl };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function locate(entry: string, version: string): Promise<Install> {
  const advice = managedBy(entry);
  if (advice) throw new UpgradeError(advice);
  const bundleDir = dirname(dirname(dirname(entry)));
  if (await exists(join(bundleDir, '.git'))) {
    throw new UpgradeError(
      `mcpcat runs from a git checkout (${bundleDir}); update it with \`git pull && npm install\``
    );
  }
  const dataDir = dirname(bundleDir);
  const current = await lstat(join(dataDir, 'current')).catch(() => undefined);
  if (basename(bundleDir) !== normalizeVersion(version) || !current?.isSymbolicLink()) {
    throw new UpgradeError(
      `mcpcat in ${bundleDir} was not installed by install.sh; reinstall it with \`${INSTALLER}\``
    );
  }
  return { dataDir, bundleDir, entry };
}

async function findLauncher(platform: Platform, install: Install): Promise<Launcher> {
  const dirs = [
    platform.env.INSTALL_DIR,
    ...(platform.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local/bin'),
  ].filter((dir): dir is string => !!dir);
  for (const dir of new Set(dirs)) {
    try {
      const path = await realpath(join(dir, 'mcpcat'));
      const parsed = parseLauncher(await readFile(path, 'utf8'));
      if (parsed && (await realpath(parsed.entry)) === install.entry) {
        return { path, node: parsed.node };
      }
    } catch {}
  }
  throw new UpgradeError(
    `can't find the launcher install.sh wrote for ${install.entry}; put its directory on PATH or in INSTALL_DIR, or reinstall with \`${INSTALLER}\``
  );
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function checkWritable(launcher: Launcher, install: Install): Promise<void> {
  const hint = 'rerun with permission to write it, or reinstall with install.sh';
  if (!(await writable(launcher.path))) {
    throw new UpgradeError(`${launcher.path} is not writable; ${hint}`);
  }
  const dir = dirname(launcher.path);
  if (!(await writable(dir))) {
    throw new UpgradeError(
      `${dir} is not writable, so ${launcher.path} can't be replaced; ${hint}`
    );
  }
  if (!(await writable(install.dataDir))) {
    throw new UpgradeError(
      `${install.dataDir} is not writable, so the new release can't be unpacked beside ${install.bundleDir}; ${hint}`
    );
  }
}

function runChild(
  argv: string[],
  ms: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ms);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      stderr += err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function unpack(tarball: string, dest: string, asset: string): Promise<void> {
  await mkdir(dest);
  const r = await runChild(['tar', 'xzf', tarball, '-C', dest, '--strip-components=1'], 120_000);
  if (r.code !== 0) {
    const reason = [`tar exited ${r.code}`, r.stderr.trim().split('\n')[0]];
    throw new UpgradeError(`unpacking ${asset}: ${reason.filter(Boolean).join(': ')}`);
  }
}

async function verify(node: string, bundle: string, version: string, ms: number): Promise<void> {
  const r = await runChild([node, join(bundle, 'dist/host/mcpcat.mjs'), '--version'], ms);
  if (r.timedOut) {
    throw new UpgradeError(
      `the downloaded mcpcat did not answer --version in ${ms / 1000} seconds`
    );
  }
  if (r.code !== 0) {
    throw new UpgradeError(`the downloaded mcpcat failed to run --version (exit ${r.code})`);
  }
  const got = r.stdout.trim();
  if (got !== version) {
    throw new UpgradeError(
      `the downloaded mcpcat reports ${JSON.stringify(got)}, expected ${JSON.stringify(version)}`
    );
  }
}

async function restore(parked: string, target: string): Promise<void> {
  try {
    await ops.rename(parked, target);
  } catch (err) {
    throw new UpgradeError(
      `${(err as Error).message}; the previous release is in ${parked}, move it back to ${target}`
    );
  }
}

async function swap(
  platform: Platform,
  install: Install,
  launcher: Launcher,
  staged: string,
  version: string
): Promise<void> {
  const target = join(install.dataDir, version);
  const parked = join(install.dataDir, `.previous-${process.pid}`);
  const park = await exists(target);
  if (park) await ops.rename(target, parked);
  try {
    await ops.rename(staged, target);
  } catch (err) {
    if (park) await restore(parked, target);
    throw new UpgradeError(`moving the new release into ${target}: ${(err as Error).message}`);
  }
  const entry = join(target, 'dist/host/mcpcat.mjs');
  const tmp = `${launcher.path}.tmp.${process.pid}`;
  try {
    await ops.writeFile(tmp, launcherText(launcher.node, entry), { mode: 0o755 });
    await chmod(tmp, 0o755);
    await ops.rename(tmp, launcher.path);
  } catch (err) {
    await rm(tmp, { force: true });
    await rm(target, { recursive: true, force: true });
    if (park) await restore(parked, target);
    throw new UpgradeError(`replacing ${launcher.path}: ${(err as Error).message}`);
  }
  const current = join(install.dataDir, 'current');
  const link = join(install.dataDir, `.current-${process.pid}`);
  try {
    await rm(link, { force: true });
    await ops.symlink(version, link);
    await ops.rename(link, current);
  } catch (err) {
    await rm(link, { force: true });
    await platform.write(
      2,
      `mcpcat: warning: could not point ${current} at ${version}: ${(err as Error).message}\n`
    );
  }
  const old = park ? parked : install.bundleDir;
  await Promise.allSettled([rm(old, { recursive: true, force: true })]);
}

async function apply(
  platform: Platform,
  release: Release,
  install: Install,
  launcher: Launcher,
  agent: string,
  ms: number
): Promise<void> {
  const sumsText = await step(`downloading ${SUMS}`, () =>
    get(platform, release.sumsUrl, agent, undefined, MAX_SUMS, 60_000)
  );
  const want = parseChecksums(new TextDecoder().decode(sumsText)).get(release.asset);
  if (!want) throw new UpgradeError(`${SUMS} has no entry for ${release.asset}`);
  const tarball = await step(`downloading ${release.asset}`, () =>
    get(platform, release.assetUrl, agent, undefined, MAX_TARBALL, 600_000)
  );
  if (createHash('sha256').update(tarball).digest('hex') !== want) {
    throw new UpgradeError(`${release.asset} does not match its SHA-256 in ${SUMS}`);
  }
  const staging = await mkdtemp(join(install.dataDir, '.upgrade-'));
  try {
    const file = join(staging, release.asset);
    await writeFile(file, tarball);
    const staged = join(staging, 'package');
    await unpack(file, staged, release.asset);
    await verify(launcher.node, staged, release.version, ms);
    await swap(platform, install, launcher, staged, release.version);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runUpgrade(
  platform: Platform,
  request: UpgradeRequest,
  options: UpgradeOptions = {}
): Promise<number> {
  const prefix = `mcpcat ${request.command}`;
  const override = platform.env[UPGRADE_API_ENV];
  if (override) {
    await platform.write(
      2,
      `${prefix}: ${UPGRADE_API_ENV} overrides the GitHub API with ${override}\n`
    );
  }
  try {
    const entry = options.entry ?? (await realpath(fileURLToPath(import.meta.url)));
    const install = await locate(entry, request.version);
    const agent = `mcpcat/${normalizeVersion(request.version)}`;
    const base = (override || DEFAULT_API).replace(/\/+$/, '');
    const release = await latest(platform, base, agent);
    const next = plan(request.version, release.version, request.check, request.force);
    if (next.kind === 'report') {
      await platform.write(1, next.text);
      return 0;
    }
    if (next.kind === 'refuse') throw new UpgradeError(next.text);
    const launcher = await findLauncher(platform, install);
    await checkWritable(launcher, install);
    await platform.write(
      1,
      `upgrading mcpcat ${normalizeVersion(request.version)} to ${release.version}\n`
    );
    await apply(platform, release, install, launcher, agent, options.verifyMs ?? VERIFY_MS);
    await platform.write(
      1,
      `upgraded ${launcher.path} to mcpcat ${release.version} (${SUMS} verified)\n`
    );
    return 0;
  } catch (err) {
    await platform.write(2, `${prefix}: ${(err as Error).message}\n`);
    return 1;
  }
}
