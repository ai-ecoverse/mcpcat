import { addServer } from '../config/edit.ts';
import { stateDir, userConfigPath } from '../config/paths.ts';
import type { Platform } from '../platform/types.ts';
import { deduplicateCandidates, extractCandidates, resetIdCounter } from './extract.ts';
import { appendCandidates, getCandidate, listCandidates } from './inbox.ts';
import { probeDiscover } from './probe.ts';
import type { Candidate, DiscoveryEvent } from './types.ts';

async function readStdin(platform: Platform): Promise<string> {
  const reader = platform.stdin.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  reader.releaseLock();
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

function parseEvents(text: string): DiscoveryEvent[] | { error: string; code: number } {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const events: DiscoveryEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { error: `invalid JSON: ${line.slice(0, 80)}`, code: 2 };
    }
    const ev = parsed as DiscoveryEvent;
    if (typeof ev.v !== 'number') return { error: 'missing event version', code: 2 };
    if (ev.v !== 1) return { error: `unknown event version: ${ev.v}`, code: 2 };
    events.push(ev);
  }
  return events;
}

function formatCandidate(c: Candidate): string {
  const parts = [`#${c.id}  ${c.standard}  ${c.endpoint}`];
  if (c.name) parts[0] += `  (${c.name})`;
  if (c.status === 'invalid') parts.push(`  status: invalid – ${c.reason ?? 'unknown'}`);
  if (c.suggestion) parts.push(`  suggestion: ${c.suggestion}`);
  for (const t of c.trust) {
    const icon = t.type.includes('mismatch') ? '⚠' : '✓';
    parts.push(`  ${icon} ${t.type}: ${t.detail}`);
  }
  return parts.join('\n');
}

function formatCandidateJson(c: Candidate): Record<string, unknown> {
  return {
    id: c.id,
    endpoint: c.endpoint,
    standard: c.standard,
    origin: c.origin,
    name: c.name,
    transport: c.transport,
    trust: c.trust,
    status: c.status,
    reason: c.reason,
    suggestion: c.suggestion,
    discoveredAt: c.discoveredAt,
  };
}

export async function runFromDiscovery(platform: Platform, args: string[]): Promise<number> {
  let source = '-';
  for (const arg of args) {
    if (arg !== '--from-discovery' && !arg.startsWith('-')) {
      source = arg;
    }
  }

  let text: string;
  if (source === '-') {
    text = await readStdin(platform);
  } else {
    try {
      const data = await platform.fs.readFile(source);
      text = new TextDecoder().decode(data);
    } catch {
      await platform.write(2, `mcpcat add --from-discovery: cannot read '${source}'\n`);
      return 2;
    }
  }

  const result = parseEvents(text);
  if ('error' in result) {
    await platform.write(2, `mcpcat add --from-discovery: ${result.error}\n`);
    return result.code;
  }

  resetIdCounter();
  let allCandidates: Candidate[] = [];
  for (const event of result) {
    allCandidates.push(...extractCandidates(event));
  }
  allCandidates = deduplicateCandidates(allCandidates);

  if (allCandidates.length === 0) {
    await platform.write(1, 'no MCP candidates found\n');
    return 0;
  }

  const sd = stateDir(platform);
  await appendCandidates(platform.fs, sd, allCandidates);

  for (const c of allCandidates) {
    await platform.write(1, `${formatCandidate(c)}\n`);
  }
  return 0;
}

export async function runInbox(platform: Platform, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const sd = stateDir(platform);
  const candidates = await listCandidates(platform.fs, sd);

  if (candidates.length === 0) {
    await platform.write(1, 'inbox is empty\n');
    return 0;
  }

  if (json) {
    await platform.write(1, JSON.stringify(candidates.map(formatCandidateJson), null, 2) + '\n');
  } else {
    for (const c of candidates) {
      await platform.write(1, `${formatCandidate(c)}\n`);
    }
  }
  return 0;
}

export async function runAddCandidate(
  platform: Platform,
  name: string,
  candidateId: string,
  configFile?: string
): Promise<number> {
  const sd = stateDir(platform);
  const candidate = await getCandidate(platform.fs, sd, candidateId);
  if (!candidate) {
    await platform.write(2, `mcpcat add: candidate #${candidateId} not found in inbox\n`);
    return 1;
  }

  if (candidate.transport === 'webmcp') {
    await platform.write(
      2,
      `mcpcat add: WebMCP candidates cannot be added directly; use: ${candidate.suggestion}\n`
    );
    return 2;
  }

  const path = configFile ?? userConfigPath(platform);
  const config = { url: candidate.endpoint };
  const { replaced } = await addServer(platform.fs, path, name, config);

  for (const t of candidate.trust) {
    if (t.type.includes('mismatch')) {
      await platform.write(2, `mcpcat add: warning: ${t.type}: ${t.detail}\n`);
    }
  }

  await platform.write(1, `${replaced ? 'replaced' : 'added'} ${name} in ${path}\n`);
  return 0;
}

export async function runDiscover(platform: Platform, args: string[]): Promise<number> {
  const positional: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length < 1) {
    await platform.write(2, 'mcpcat discover: requires a URL\n');
    return 2;
  }

  const url = positional[0];
  if (!URL.canParse(url)) {
    await platform.write(2, `mcpcat discover: '${url}' is not a valid URL\n`);
    return 2;
  }

  const { events } = await probeDiscover(platform, url);

  resetIdCounter();
  let allCandidates: Candidate[] = [];
  for (const event of events) {
    allCandidates.push(...extractCandidates(event));
  }
  allCandidates = deduplicateCandidates(allCandidates);

  if (allCandidates.length > 0) {
    const sd = stateDir(platform);
    await appendCandidates(platform.fs, sd, allCandidates);
  }

  if (allCandidates.length === 0) {
    await platform.write(1, 'no MCP candidates found\n');
    return 0;
  }

  if (json) {
    await platform.write(1, JSON.stringify(allCandidates.map(formatCandidateJson), null, 2) + '\n');
  } else {
    for (const c of allCandidates) {
      await platform.write(1, `${formatCandidate(c)}\n`);
    }
  }
  return 0;
}
