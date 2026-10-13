import { createKernelPlatform } from './platform/kernel.ts';
import { run } from './cli/main.ts';

declare const MCPCAT_VERSION: string;

export default async function main(ctx: Parameters<typeof createKernelPlatform>[0]) {
  const platform = createKernelPlatform(ctx);
  const args = ctx.argv.slice(1);
  return run(platform, MCPCAT_VERSION, args);
}
