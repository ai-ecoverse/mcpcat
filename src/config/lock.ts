import { usageError } from '../cli/exit-codes.ts';
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

async function removeStaleLockDir(fs: FsApi, lockPath: string): Promise<boolean> {
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

async function removeStaleLockFile(fs: FsApi, lockPath: string): Promise<boolean> {
  try {
    const s = await fs.stat(lockPath);
    if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
      try {
        await fs.unlink!(lockPath);
      } catch {}
      return true;
    }
  } catch {}
  return false;
}

interface HeldLock {
  path: string;
  useFile: boolean;
  fs: FsApi;
}

const heldLocks = new Set<HeldLock>();

export function releaseAllLocksSync(): void {
  for (const lock of heldLocks) {
    try {
      if (lock.useFile && lock.fs.unlink) {
        void lock.fs.unlink(lock.path).catch(() => {});
      } else {
        void lock.fs.rmdir(lock.path).catch(() => {});
      }
    } catch {}
  }
  heldLocks.clear();
}

export async function releaseAllLocks(): Promise<void> {
  const locks = [...heldLocks];
  heldLocks.clear();
  for (const lock of locks) {
    try {
      if (lock.useFile && lock.fs.unlink) {
        await lock.fs.unlink(lock.path);
      } else {
        await lock.fs.rmdir(lock.path);
      }
    } catch {}
  }
}

export async function acquireLock(fs: FsApi, configPath: string): Promise<() => Promise<void>> {
  const useFile = typeof fs.createExclusive === 'function';
  const lockPath = `${configPath}.lock`;
  const start = Date.now();

  const parentDir = lockPath.slice(0, lockPath.lastIndexOf('/'));
  if (parentDir) {
    try {
      await fs.mkdir(parentDir);
    } catch {}
  }

  while (true) {
    try {
      if (useFile) {
        await fs.createExclusive!(lockPath);
      } else {
        await fs.mkdirExclusive(lockPath);
      }
      break;
    } catch (err) {
      if (!isEexist(err)) {
        throw usageError(`could not write ${lockPath}: ${(err as Error).message}`);
      }
      if (useFile) {
        await removeStaleLockFile(fs, lockPath);
      } else {
        await removeStaleLockDir(fs, lockPath);
      }
    }
    if (Date.now() - start > LOCK_MAX_WAIT_MS) {
      throw new Error(`mcpcat: could not acquire lock ${lockPath} within ${LOCK_MAX_WAIT_MS}ms`);
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }

  const entry: HeldLock = { path: lockPath, useFile, fs };
  heldLocks.add(entry);

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    heldLocks.delete(entry);
    try {
      if (useFile && fs.unlink) {
        await fs.unlink(lockPath);
      } else {
        await fs.rmdir(lockPath);
      }
    } catch {}
  };
}
