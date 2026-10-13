import { run } from './cli/main.ts';
import { createHostPlatform } from './platform/host.ts';

declare const MCPCAT_VERSION: string;

let _seaAssetDir: string | undefined;
let _seaUnpacked = false;

function getSeaAssetDir(): string | undefined {
  if (_seaUnpacked) return _seaAssetDir;
  _seaUnpacked = true;

  try {
    const sea = require('node:sea') as typeof import('node:sea');
    if (!sea.isSea()) return undefined;

    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'mcpcat-sea-'));
    writeFileSync(join(dir, 'codemode-worker.mjs'), sea.getAsset('codemode-worker.mjs', 'utf8'));
    writeFileSync(join(dir, 'quickjs.wasm'), new Uint8Array(sea.getRawAsset('quickjs.wasm')));
    _seaAssetDir = dir;

    process.on('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });
  } catch {}

  return _seaAssetDir;
}

(globalThis as Record<string, unknown>).__mcpcat_get_sea_asset_dir = getSeaAssetDir;

async function main() {
  const platform = createHostPlatform();
  const args = process.argv.slice(2);
  const code = await run(platform, MCPCAT_VERSION, args);
  process.exit(code);
}

void main();
