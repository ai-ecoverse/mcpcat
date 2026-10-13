import type { Platform } from '../platform/types.ts';

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

interface InputSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface InputRequest {
  schema?: InputSchema;
  message?: string;
  url?: string;
}

export interface ElicitResult {
  answers: Record<string, unknown>;
}

function readLine(platform: Platform): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = platform.stdin.getReader();
    const chunks: Uint8Array[] = [];
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          reader.releaseLock();
          resolve(new TextDecoder().decode(concatChunks(chunks)).split('\n')[0] ?? '');
          return;
        }
        chunks.push(value);
        const text = new TextDecoder().decode(concatChunks(chunks));
        if (text.includes('\n')) {
          reader.releaseLock();
          resolve(text.split('\n')[0]);
          return;
        }
        pump();
      }, reject);
    }
    pump();
  });
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

function coerceValue(raw: string, type: string | undefined): unknown {
  if (!type || type === 'string') return raw;
  if (type === 'integer') return Number.parseInt(raw, 10);
  if (type === 'number') return Number.parseFloat(raw);
  if (type === 'boolean') return raw === 'true' || raw === '1' || raw === 'yes';
  return raw;
}

export async function promptForSchema(
  platform: Platform,
  schema: InputSchema
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(properties)) {
    const req = required.has(key) ? ' (required)' : '';
    const desc = prop.description ? ` - ${prop.description}` : '';
    const def = prop.default !== undefined ? ` [${String(prop.default)}]` : '';
    const choices = prop.enum ? ` (${prop.enum.join('|')})` : '';
    await platform.write(2, `${key}${req}${desc}${choices}${def}: `);
    const line = await readLine(platform);
    const value = line.trim();
    if (value === '' && prop.default !== undefined) {
      answers[key] = prop.default;
    } else if (value !== '') {
      answers[key] = coerceValue(value, prop.type);
    }
  }
  return answers;
}

export function parseInputRequest(result: Record<string, unknown>): InputRequest | undefined {
  const ir = result.inputRequest as Record<string, unknown> | undefined;
  if (!ir && !result.inputRequests) return undefined;
  if (ir) return ir as InputRequest;
  const reqs = result.inputRequests as InputRequest[] | undefined;
  if (Array.isArray(reqs) && reqs.length > 0) return reqs[0];
  return undefined;
}

export async function handleElicitation(
  platform: Platform,
  inputRequest: InputRequest,
  isTty: boolean,
  respondData: Record<string, unknown> | undefined
): Promise<{ answers: Record<string, unknown> } | { exitCode: number }> {
  if (inputRequest.url) {
    if (isTty) {
      await platform.write(2, `Open this URL to continue: ${inputRequest.url}\n`);
      await platform.write(2, 'Press Enter when done...');
      await readLine(platform);
      return { answers: {} };
    }
    return { exitCode: 6 };
  }

  if (respondData) {
    return { answers: respondData };
  }

  if (!isTty) {
    return { exitCode: 6 };
  }

  const schema = inputRequest.schema ?? { type: 'object', properties: {} };
  if (inputRequest.message) {
    await platform.write(2, `${inputRequest.message}\n`);
  }
  const answers = await promptForSchema(platform, schema);
  return { answers };
}
