import type {
  CallToolResult,
  ContentBlock,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
} from '@earendil-works/pi-mcp';
import type { GetPromptResult, PromptInfo } from '../client/connection.ts';
import type { Platform } from '../platform/types.ts';
import { sanitizeTerminal } from './sanitize.ts';

export type Redactor = (text: string) => string;

export interface RenderOptions {
  json?: boolean;
  outputPath?: string;
  maxChars?: number;
  redact?: Redactor;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)}\n[…]\n${text.slice(-half)}`;
}

function renderContentBlock(block: ContentBlock): string | undefined {
  if (block.type === 'text') return block.text;
  if (block.type === 'image') {
    const size = formatBytes(Math.ceil((block.data.length * 3) / 4));
    return `[image: ${block.mimeType}, ${size}]`;
  }
  if (block.type === 'audio') {
    const audioBlock = block as unknown as { data: string; mimeType: string };
    const size = formatBytes(Math.ceil((audioBlock.data.length * 3) / 4));
    return `[audio: ${audioBlock.mimeType}, ${size}]`;
  }
  if (block.type === 'resource_link') return `[resource: ${block.uri}]`;
  if (block.type === 'resource') {
    return 'text' in block.resource ? block.resource.text : `[blob: ${block.resource.uri}]`;
  }
  return undefined;
}

export function renderCallResultText(result: CallToolResult, options?: RenderOptions): string {
  const parts: string[] = [];
  if (result.content) {
    for (const block of result.content) {
      const rendered = renderContentBlock(block);
      if (rendered !== undefined) parts.push(rendered);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  let text = parts.join('\n');
  if (options?.maxChars && text.length > options.maxChars) {
    text = truncateMiddle(text, options.maxChars);
  }
  return text;
}

export function renderCallResultJson(result: CallToolResult): string {
  return JSON.stringify(result, null, 2);
}

export async function renderCallResult(
  platform: Platform,
  result: CallToolResult,
  options?: RenderOptions
): Promise<number> {
  const r = options?.redact ?? ((s: string) => s);

  if (options?.outputPath) {
    const content = options.json
      ? renderCallResultJson(result)
      : renderCallResultText(result, options);
    await platform.fs.writeFile(options.outputPath, content);
    if (result.isError) {
      await platform.write(
        2,
        r(`${result.isError ? '(tool reported error)' : ''}
`)
      );
      return 1;
    }
    return 0;
  }

  if (options?.json) {
    const json = renderCallResultJson(result);
    if (result.isError) {
      await platform.write(
        2,
        r(`${JSON.stringify({ error: { kind: 'tool_error', message: json } }, null, 2)}\n`)
      );
      return 1;
    }
    await platform.write(1, `${json}\n`);
    return 0;
  }

  const text = renderCallResultText(result, options);
  if (result.isError) {
    await platform.write(2, sanitizeTerminal(r(`${text || '(tool reported error)'}\n`)));
    return 1;
  }
  if (text) {
    await platform.write(1, `${text}\n`);
  }
  return 0;
}

export async function renderToolsJson(
  platform: Platform,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  hint?: string
): Promise<void> {
  await platform.write(1, `${JSON.stringify(hint ? { tools, hint } : { tools }, null, 2)}\n`);
}

export async function renderInfoJson(
  platform: Platform,
  info: Record<string, unknown>
): Promise<void> {
  await platform.write(1, `${JSON.stringify(info, null, 2)}\n`);
}

export async function renderErrorJson(
  platform: Platform,
  kind: string,
  message: string,
  code?: number,
  data?: unknown,
  redact?: Redactor
): Promise<void> {
  const r = redact ?? ((s: string) => s);
  const errorObj: Record<string, unknown> = { kind, message: r(message) };
  if (code !== undefined) errorObj.code = code;
  if (data !== undefined) errorObj.data = data;
  await platform.write(2, `${JSON.stringify({ error: errorObj }, null, 2)}\n`);
}

export async function renderResourcesJson(
  platform: Platform,
  resources: Resource[],
  templates: ResourceTemplate[]
): Promise<void> {
  await platform.write(
    1,
    `${JSON.stringify({ resources, resourceTemplates: templates }, null, 2)}\n`
  );
}

export async function renderPromptsJson(platform: Platform, prompts: PromptInfo[]): Promise<void> {
  await platform.write(1, `${JSON.stringify({ prompts }, null, 2)}\n`);
}

export async function renderPromptResultJson(
  platform: Platform,
  result: GetPromptResult
): Promise<void> {
  await platform.write(1, `${JSON.stringify(result, null, 2)}\n`);
}

export async function renderReadResourceJson(
  platform: Platform,
  result: ReadResourceResult
): Promise<void> {
  await platform.write(1, `${JSON.stringify(result, null, 2)}\n`);
}
