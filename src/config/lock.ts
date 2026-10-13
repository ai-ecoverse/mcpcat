import type { FsApi } from '../platform/types.ts';

const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

function isEexist(err: unknown): boolean {
  if (err instanceof Error && 'code' in err)
    return (err as NodeJS.ErrnoException).code === 'EEXIST';
  if (err instanceof Error) return err.message.includes('EEXIST');
  return false;
}

async function removeStaleLock(fs: FsApi, lockPath: string): Promise<boolean> {
  try {
    const s = await fs.stat(lockPath);
    if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
      try {
        await fs.rmdir(lockPath);
      } catch {}
      return true;
    }
  } catch {}
  return false;
}

export async function acquireLock(fs: FsApi, configPath: string): Promise<() => Promise<void>> {
  const lockPath = `${configPath}.lock`;
  const start = Date.now();

  while (true) {
    try {
      await fs.mkdirExclusive(lockPath);
      break;
    } catch (err) {
      if (!isEexist(err)) throw err;
      await removeStaleLock(fs, lockPath);
    }
    if (Date.now() - start > LOCK_MAX_WAIT_MS) {
      throw new Error(`mcpcat: could not acquire lock ${lockPath} within ${LOCK_MAX_WAIT_MS}ms`);
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await fs.rmdir(lockPath);
    } catch {}
  };
}
