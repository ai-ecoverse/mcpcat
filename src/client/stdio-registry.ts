import type { SpawnResult } from '../platform/types.ts';

const GRACE_MS = 2000;
const registry = new Set<SpawnResult>();

export function trackStdio(proc: SpawnResult): void {
  registry.add(proc);
  void proc.wait().then(
    () => registry.delete(proc),
    () => registry.delete(proc)
  );
}

export function untrackStdio(proc: SpawnResult): void {
  registry.delete(proc);
}

export async function killAllStdio(): Promise<void> {
  const procs = [...registry];
  if (procs.length === 0) return;
  await Promise.all(
    procs.map(async (proc) => {
      try {
        await proc.kill('SIGTERM');
      } catch {}
      const exited = await Promise.race([
        proc.wait().then(() => true as const),
        new Promise<false>((r) => setTimeout(() => r(false), GRACE_MS)),
      ]);
      if (!exited) {
        try {
          await proc.kill('SIGKILL');
        } catch {}
      }
    })
  );
  registry.clear();
}
