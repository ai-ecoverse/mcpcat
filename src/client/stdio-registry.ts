import type { SpawnResult } from '../platform/types.ts';
import { reap } from './reap.ts';

const GRACE_MS = 2000;
const registry = new Set<SpawnResult>();

export function trackStdio(proc: SpawnResult): void {
  registry.add(proc);
}

export function untrackStdio(proc: SpawnResult): void {
  registry.delete(proc);
}

export async function reapStdio(proc: SpawnResult, graceMs = GRACE_MS): Promise<void> {
  try {
    await reap(proc, graceMs);
  } finally {
    registry.delete(proc);
  }
}

export async function killAllStdio(): Promise<void> {
  const procs = [...registry];
  if (procs.length === 0) return;
  await Promise.all(procs.map((proc) => reapStdio(proc)));
  registry.clear();
}
