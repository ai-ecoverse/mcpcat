import type { FsApi } from '../platform/types.ts';
import type { Candidate, InboxData } from './types.ts';

function inboxPath(stateDir: string): string {
  return `${stateDir}/inbox.json`;
}

async function readInbox(fs: FsApi, stateDir: string): Promise<InboxData> {
  try {
    const data = await fs.readFile(inboxPath(stateDir));
    const parsed = JSON.parse(new TextDecoder().decode(data));
    if (parsed && Array.isArray(parsed.candidates)) return parsed as InboxData;
  } catch {}
  return { candidates: [] };
}

async function writeInbox(fs: FsApi, stateDir: string, inbox: InboxData): Promise<void> {
  try {
    await fs.mkdir(stateDir);
  } catch {}
  const json = JSON.stringify(inbox, null, 2) + '\n';
  await fs.writeFile(inboxPath(stateDir), json);
}

export async function appendCandidates(
  fs: FsApi,
  stateDir: string,
  candidates: Candidate[]
): Promise<void> {
  const inbox = await readInbox(fs, stateDir);
  const existing = new Set(inbox.candidates.map((c) => c.endpoint));
  for (const c of candidates) {
    if (existing.has(c.endpoint)) continue;
    existing.add(c.endpoint);
    inbox.candidates.push(c);
  }
  await writeInbox(fs, stateDir, inbox);
}

export async function listCandidates(fs: FsApi, stateDir: string): Promise<Candidate[]> {
  const inbox = await readInbox(fs, stateDir);
  return inbox.candidates.slice().reverse();
}

export async function getCandidate(
  fs: FsApi,
  stateDir: string,
  id: string
): Promise<Candidate | undefined> {
  const inbox = await readInbox(fs, stateDir);
  return inbox.candidates.find((c) => c.id === id);
}
