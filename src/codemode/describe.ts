import type { Tool } from '@earendil-works/pi-mcp';
import type { McpConnection } from '../client/connection.ts';
import type { Platform } from '../platform/types.ts';
import { rankDocuments, type SearchDocument } from './search.ts';

export interface DescribeTarget {
  name: string;
  conn: McpConnection;
  instructions?: string;
}

function toolDeclaration(tool: Tool): {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
} {
  const outputSchema = (tool as unknown as Record<string, unknown>).outputSchema as
    | Record<string, unknown>
    | undefined;
  return {
    name: `${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    outputSchema: outputSchema ?? { type: 'string' },
  };
}

export async function runDescribeTs(
  platform: Platform,
  targets: DescribeTarget[],
  budget?: number
): Promise<number> {
  const { renderDeclarations } = await import('@earendil-works/pi-codemode');

  const allTools: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }[] = [];

  for (const target of targets) {
    const tools = await target.conn.listTools();
    for (const tool of tools) {
      const decl = toolDeclaration(tool);
      allTools.push({
        ...decl,
        name: `mcp__${target.name}__${tool.name}`,
      });
    }
  }

  if (allTools.length === 0) {
    await platform.write(1, '(no tools)\n');
    return 0;
  }

  const output = renderDeclarations({
    tools: allTools as unknown as Parameters<typeof renderDeclarations>[0]['tools'],
  });
  await platform.write(1, `${output}\n`);
  return 0;
}

export interface GrepTarget {
  name: string;
  conn: McpConnection;
  instructions?: string;
}

export async function runGrep(
  platform: Platform,
  pattern: string,
  targets: GrepTarget[],
  options: { rank?: boolean; extended?: boolean }
): Promise<number> {
  const documents: { name: string; text: string; server: string }[] = [];

  for (const target of targets) {
    const info = await target.conn.info();
    const tools = await target.conn.listTools();
    for (const tool of tools) {
      const qualifiedName = `mcp__${target.name}__${tool.name}`;
      const parts = [qualifiedName, tool.name, tool.description ?? ''];
      if (info.instructions) parts.push(info.instructions);
      documents.push({ name: qualifiedName, text: parts.join(' '), server: target.name });
    }
  }

  if (documents.length === 0) return 1;

  if (options.rank) {
    const searchDocs: SearchDocument[] = documents.map((d) => ({ name: d.name, text: d.text }));
    const ranked = rankDocuments(pattern, searchDocs, documents.length);
    if (ranked.length === 0) return 1;
    for (const name of ranked) {
      const doc = documents.find((d) => d.name === name)!;
      const _tool = doc.text.split(' ').slice(0, 2).join(' ');
      await platform.write(1, `${name}\n`);
    }
    return 0;
  }

  const flags = options.extended ? 'i' : 'i';
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    await platform.write(2, `mcpcat: invalid pattern: ${pattern}\n`);
    return 2;
  }

  let found = false;
  for (const doc of documents) {
    if (re.test(doc.text)) {
      await platform.write(1, `${doc.name}\n`);
      found = true;
    }
  }

  return found ? 0 : 1;
}

export function buildSearchDocuments(
  tools: { name: string; jsName: string; description: string }[],
  namespaces: { name: string; description?: string; tools: string[] }[]
): SearchDocument[] {
  return tools.map((tool) => {
    const ns = namespaces.find((n) => n.tools.includes(tool.name));
    const parts = [tool.name, tool.name.replaceAll('_', ' '), tool.description];
    if (ns) {
      parts.push(ns.name);
      if (ns.description) parts.push(ns.description);
    }
    return { name: tool.name, text: parts.join(' ') };
  });
}
