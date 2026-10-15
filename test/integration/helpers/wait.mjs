import { setTimeout as sleep } from 'node:timers/promises';

export async function waitUntil(probe, what, timeoutMs = 15_000, intervalMs = 50) {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}
