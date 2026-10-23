export const UPGRADE_REPO = 'ai-ecoverse/mcpcat';
export const UPGRADE_API_ENV = 'MCPCAT_UPDATE_API_BASE';
export const SUMS = 'SHA256SUMS';
export const INSTALLER = 'curl -fsSL https://get.sliccy.ai/mcpcat | sh';

export interface UpgradeRequest {
  command: string;
  version: string;
  check: boolean;
  force: boolean;
}

export function upgradeUsage(command: string): string {
  return `mcpcat ${command} [--check] [--force]

Replace this mcpcat with the latest release of ${UPGRADE_REPO} from GitHub, over https only.
The release tarball must match the release's ${SUMS}, and the unpacked mcpcat must report
the release version, before it replaces this one. Only an install.sh install is replaced,
and only when its launcher, the launcher's directory and the install directory are writable.
A copy installed with npm, npx or pnpm, or run from a git checkout, is not replaced;
mcpcat ${command} prints how to update it. Not available in the kernel build.

Options:
  --check                    Only report whether a newer release exists
  --force                    Replace a development build, or reinstall the current release
  -h, --help                 Show this help
`;
}

export type UpgradeArgs =
  | { kind: 'run'; check: boolean; force: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export function parseUpgradeArgs(args: string[]): UpgradeArgs {
  let check = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--check') check = true;
    else if (arg === '--force') force = true;
    else if (arg.startsWith('-')) return { kind: 'error', message: `unknown option ${arg}` };
    else return { kind: 'error', message: `unexpected argument '${arg}'` };
  }
  return { kind: 'run', check, force };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function allowedUrl(text: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`bad URL ${JSON.stringify(text)}`);
  }
  if (parsed.protocol === 'https:' && parsed.hostname !== '') return parsed;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) return parsed;
  throw new Error(
    `refusing ${parsed.protocol}//${parsed.host}: releases are fetched over https, or plain http only from 127.0.0.1, ::1 or localhost`
  );
}

export function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

export function isReleaseVersion(version: string): boolean {
  return /^\d+(\.\d+)*$/.test(normalizeVersion(version));
}

function segments(version: string): number[] {
  return normalizeVersion(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isDevelopment(version: string): boolean {
  return !isReleaseVersion(version) || segments(version).every((part) => part === 0);
}

export function isNewer(latest: string, current: string): boolean {
  const a = segments(latest);
  const b = segments(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

export type Plan =
  | { kind: 'report'; text: string }
  | { kind: 'refuse'; text: string }
  | { kind: 'replace' };

export function plan(currentVersion: string, latest: string, check: boolean, force: boolean): Plan {
  const dev = isDevelopment(currentVersion);
  const current = normalizeVersion(currentVersion);
  const newer = isNewer(latest, current);
  const upToDate: Plan = { kind: 'report', text: `mcpcat ${current} is up to date\n` };
  if (check) {
    if (dev) {
      return {
        kind: 'report',
        text: `latest release: ${latest} (this is a development build, ${current})\n`,
      };
    }
    if (newer) {
      return {
        kind: 'report',
        text: `mcpcat ${latest} is available (you have ${current}); run \`mcpcat upgrade\`\n`,
      };
    }
    return upToDate;
  }
  if (dev && !force) {
    return {
      kind: 'refuse',
      text: `refusing to replace a development build (${current}) with release ${latest}; pass --force to replace it`,
    };
  }
  if (!dev && !force && !newer) return upToDate;
  return { kind: 'replace' };
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) continue;
    const [sum, name] = fields;
    sums.set(name.replace(/^\*/, ''), sum.toLowerCase());
  }
  return sums;
}

const PACKAGE = '@ai-ecoverse/mcpcat';

export function managedBy(entry: string): string | undefined {
  const parts = entry.split(/[\\/]/);
  if (parts.includes('_npx')) {
    return `mcpcat runs from npx; run \`npx ${PACKAGE}@latest\` for the latest`;
  }
  if (parts.includes('.pnpm') || parts.includes('pnpm')) {
    return `mcpcat was installed with pnpm; update it with \`pnpm add -g ${PACKAGE}@latest\``;
  }
  if (parts.includes('node_modules')) {
    return `mcpcat was installed with npm; update it with \`npm i -g ${PACKAGE}\`, or with \`npm i ${PACKAGE}@latest\` in the project that depends on it`;
  }
  return undefined;
}

export function launcherText(node: string, entry: string): string {
  return `#!/bin/sh\nexec "${node}" "${entry}" "$@"\n`;
}

export function parseLauncher(text: string): { node: string; entry: string } | undefined {
  const m = /^#!\/bin\/sh\nexec "([^"]+)" "([^"]+)" "\$@"\n$/.exec(text);
  return m ? { node: m[1], entry: m[2] } : undefined;
}
