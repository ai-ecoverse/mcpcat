import { run } from './cli/main.ts';
import { createHostPlatform } from './platform/host.ts';

declare const MCPCAT_VERSION: string;

async function main() {
  let seaAssetDir: string | undefined;

  try {
    const sea = await import('node:sea');
    if (sea.isSea()) {
      const { tmpdir } = await import('node:os');
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');

      const dir = mkdtempSync(join(tmpdir(), 'mcpcat-sea-'));
      writeFileSync(join(dir, 'codemode-worker.mjs'), sea.getAsset('codemode-worker.mjs', 'utf8'));
      writeFileSync(join(dir, 'quickjs.wasm'), new Uint8Array(sea.getRawAsset('quickjs.wasm')));
      seaAssetDir = dir;

      process.on('exit', () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      });
    }
  } catch {}

  const platform = createHostPlatform();
  const args = process.argv.slice(2);

  if (seaAssetDir) {
    (globalThis as Record<string, unknown>).__mcpcat_sea_asset_dir = seaAssetDir;
  }

  const code = await run(platform, MCPCAT_VERSION, args);
  process.exit(code);
}

void main();
