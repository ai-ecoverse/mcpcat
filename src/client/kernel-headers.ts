import type { Platform } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';

const FORBIDDEN = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'access-control-request-private-network',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const warned = new Set<string>();

function forbidden(name: string): boolean {
  const n = name.trim().toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith('proxy-') || n.startsWith('sec-');
}

export async function warnUnsentHeaders(
  platform: Platform,
  verb: string,
  names: Iterable<string>
): Promise<Set<string>> {
  const unsent = new Set(platform.kind === 'kernel' ? [...names].filter(forbidden) : []);
  for (const name of unsent) {
    if (warned.has(name.toLowerCase())) continue;
    warned.add(name.toLowerCase());
    await platform.write(
      2,
      sanitizeTerminal(
        `${verb}: warning: mcpcat won't send ${name} from the kernel: its fetch drops forbidden request headers (ai-ecoverse/slicc-kernel#1796)\n`
      )
    );
  }
  return unsent;
}

export async function dropUnsentHeaders(
  platform: Platform,
  headers: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!headers) return headers;
  const unsent = await warnUnsentHeaders(platform, 'mcpcat', Object.keys(headers));
  if (unsent.size === 0) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !unsent.has(name)));
}
