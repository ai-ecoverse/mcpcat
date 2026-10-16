import type { SpawnResult } from '../platform/types.ts';

const POLL_MS = 25;

async function gone(proc: SpawnResult, exited: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (exited() && !(await proc.groupAlive?.())) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function reap(proc: SpawnResult, graceMs: number): Promise<void> {
  let exited = false;
  void proc.wait().then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    }
  );
  try {
    await proc.kill('SIGTERM');
  } catch {}
  if (await gone(proc, () => exited, graceMs)) return;
  try {
    await proc.kill('SIGKILL');
  } catch {}
  await gone(proc, () => exited, graceMs);
}
