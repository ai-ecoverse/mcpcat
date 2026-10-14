import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const AMBIENT = [
  'PI_CODING_AGENT_DIR',
  'SLICC_JERK_CONFIG',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
];

function hasJerk(dir) {
  return existsSync(join(dir, 'jerk')) || existsSync(join(dir, 'jerk.exe'));
}

function isolate() {
  const base = mkdtempSync(join(tmpdir(), 'mcpcat-test-'));
  const home = join(base, 'home');
  const nodeDir = join(base, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(nodeDir, { recursive: true });
  symlinkSync(process.execPath, join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'));
  const kept = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir && !hasJerk(dir));
  for (const name of AMBIENT) delete process.env[name];
  process.env.PATH = [nodeDir, ...kept].join(delimiter);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.on('exit', () => rmSync(base, { recursive: true, force: true }));
}

isolate();
