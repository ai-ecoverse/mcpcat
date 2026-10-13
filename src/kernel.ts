import { run } from './cli/main.ts';
import { createKernelPlatform } from './platform/kernel.ts';

declare const MCPCAT_VERSION: string;

export default async function main(ctx: Parameters<typeof createKernelPlatform>[0]) {
  const platform = createKernelPlatform(ctx, {
    packageDir: '/node_modules/@ai-ecoverse/mcpcat',
  });
  const args = ctx.argv.slice(1);
  return run(platform, MCPCAT_VERSION, args);
}
