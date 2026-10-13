import { toCodemodeIdentifier } from '@earendil-works/pi-codemode';
import { parseCodemodeSource } from '@earendil-works/pi-codemode/source';
import type { McpConnection } from '../client/connection.ts';
import type { Platform } from '../platform/types.ts';
import { rankDocuments, type SearchDocument } from './search.ts';

type DeclaredTool = { name: string; jsName: string; description: string };
type Namespace = {
  name: string;
  description?: string;
  instructions?: string;
  tools: string[];
};

interface CodeTarget {
  name: string;
  conn: McpConnection;
  instructions?: string;
}

interface CodeOptions {
  json?: boolean;
  timeoutMs?: number;
  allowShell?: boolean;
  stateDir?: string;
  platform: Platform;
}

async function loadStore(platform: Platform, stateDir: string): Promise<Record<string, unknown>> {
  const storePath = `${stateDir}/codemode-store.json`;
  try {
    const data = await platform.fs.readFile(storePath);
    return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveStore(
  platform: Platform,
  stateDir: string,
  store: Record<string, unknown>,
  writes: { set: Record<string, unknown>; delete: string[] }
): Promise<void> {
  for (const key of writes.delete) delete store[key];
  Object.assign(store, writes.set);
  await platform.fs.mkdir(stateDir);
  const storePath = `${stateDir}/codemode-store.json`;
  await platform.fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

async function collectTools(targets: CodeTarget[]) {
  const connections = new Map<string, McpConnection>();
  const allDeclaredTools: DeclaredTool[] = [];
  const namespaces: Namespace[] = [];

  for (const target of targets) {
    connections.set(target.name, target.conn);
    const tools = await target.conn.listTools();
    const ns: Namespace = {
      name: target.name,
      ...(target.instructions ? { instructions: target.instructions } : {}),
      tools: [],
    };
    for (const tool of tools) {
      const qualifiedName = `mcp__${target.name}__${tool.name}`;
      allDeclaredTools.push({
        name: qualifiedName,
        jsName: toCodemodeIdentifier(qualifiedName),
        description: buildToolSample(tool, qualifiedName),
      });
      ns.tools.push(qualifiedName);
    }
    namespaces.push(ns);
  }

  return { connections, allDeclaredTools, namespaces };
}

function buildSearchDocs(
  allDeclaredTools: DeclaredTool[],
  namespaces: Namespace[]
): SearchDocument[] {
  return allDeclaredTools.map((tool) => {
    const ns = namespaces.find((n) => n.tools.includes(tool.name));
    const parts = [tool.name, tool.name.replaceAll('_', ' '), tool.description];
    if (ns) {
      parts.push(ns.name);
      if (ns.description) parts.push(ns.description);
    }
    return { name: tool.name, text: parts.join(' ') };
  });
}

function buildToolImpls(allDeclaredTools: DeclaredTool[], connections: Map<string, McpConnection>) {
  return allDeclaredTools.map((decl) => {
    const parts = decl.name.split('__');
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__');
    return {
      name: decl.name,
      description: decl.description,
      execute: async (args: unknown) => {
        const conn = connections.get(serverName!);
        if (!conn) throw new Error(`Server ${serverName} not connected`);
        const result = await conn.callTool(toolName, (args ?? {}) as Record<string, unknown>);
        if (result.isError) {
          const text = result.content
            ?.filter((c) => c.type === 'text')
            .map((c) => (c as { text: string }).text)
            .join('\n');
          throw new Error(text || `Tool ${toolName} failed`);
        }
        if (result.structuredContent !== undefined) return result.structuredContent;
        const textParts = result.content
          ?.filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text);
        return textParts?.join('\n') ?? '';
      },
    };
  });
}

function buildDiscoveryGlobals(
  allDeclaredTools: DeclaredTool[],
  namespaces: Namespace[],
  searchDocs: SearchDocument[]
) {
  return [
    {
      name: 'searchTools',
      spread: true,
      signature:
        '(query: string, options?: { limit?: number; namespace?: string }): Promise<Array<{ name: string; description: string }>>',
      execute: async (args: unknown) => {
        const arr = args as unknown[];
        const [query, opts] = arr;
        if (typeof query !== 'string') throw new Error('searchTools() expects a query string');
        const limit = (opts as { limit?: number } | undefined)?.limit ?? 8;
        const ns = (opts as { namespace?: string } | undefined)?.namespace;
        let docs = searchDocs;
        if (typeof ns === 'string') {
          const nsObj = namespaces.find(
            (n) => n.name === ns || toCodemodeIdentifier(n.name) === toCodemodeIdentifier(ns)
          );
          if (nsObj) {
            docs = searchDocs.filter((d) => nsObj.tools.includes(d.name));
          }
        }
        const ranked = rankDocuments(query as string, docs, limit);
        return ranked.map((name) => {
          const tool = allDeclaredTools.find((t) => t.name === name)!;
          return { name: tool.jsName, description: tool.description };
        });
      },
    },
    {
      name: 'describeTool',
      spread: true,
      signature: '(name: string): Promise<string | undefined>',
      execute: async (args: unknown) => {
        const [name] = args as unknown[];
        if (typeof name !== 'string') throw new Error('describeTool() expects a tool name');
        const tool = allDeclaredTools.find((t) => t.name === name || t.jsName === name);
        return tool?.description;
      },
    },
    {
      name: 'describeNamespace',
      spread: true,
      signature:
        '(name: string): Promise<{ name: string; description?: string; instructions?: string; tools: string[] } | undefined>',
      execute: async (args: unknown) => {
        const [name] = args as unknown[];
        if (typeof name !== 'string')
          throw new Error('describeNamespace() expects a namespace name');
        const ns = namespaces.find(
          (n) => n.name === name || toCodemodeIdentifier(n.name) === toCodemodeIdentifier(name)
        );
        if (!ns) return undefined;
        return {
          name: ns.name,
          ...(ns.description ? { description: ns.description } : {}),
          ...(ns.instructions ? { instructions: ns.instructions } : {}),
          tools: ns.tools.map(toCodemodeIdentifier),
        };
      },
    },
  ];
}

function buildShellGlobal(platform: Platform) {
  return {
    name: 'shell',
    spread: true,
    signature:
      '(argv: string[], options?: { stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>',
    execute: async (args: unknown) => {
      const arr = args as unknown[];
      const [argv, opts] = arr;
      if (!Array.isArray(argv) || argv.length === 0) throw new Error('shell() expects argv');
      const stdinData = (opts as { stdin?: string } | undefined)?.stdin;
      const proc = await platform.spawn({ argv: argv as string[] });
      if (stdinData) {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(stdinData));
        await writer.close();
      } else {
        await proc.stdin.getWriter().close();
      }
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      const { status } = await proc.wait();
      return { stdout, stderr, exitCode: status };
    },
  };
}

export async function runCode(
  targets: CodeTarget[],
  source: string,
  options: CodeOptions
): Promise<number> {
  const { platform, json } = options;
  const { code, options: sourceOptions } = parseCodemodeSource(source);
  const timeoutMs = sourceOptions.timeoutMs ?? options.timeoutMs ?? 300_000;

  const { connections, allDeclaredTools, namespaces } = await collectTools(targets);
  const searchDocs = buildSearchDocs(allDeclaredTools, namespaces);
  const stateDir =
    options.stateDir ??
    `${platform.env.XDG_STATE_HOME ?? `${platform.env.HOME ?? '.'}/.local/state`}/mcpcat`;
  const store = await loadStore(platform, stateDir);
  const toolImpls = buildToolImpls(allDeclaredTools, connections);
  const globals = [
    ...buildDiscoveryGlobals(allDeclaredTools, namespaces, searchDocs),
    ...(options.allowShell ? [buildShellGlobal(platform)] : []),
  ];

  const sandbox = await createSandbox(platform, toolImpls, globals, timeoutMs);

  try {
    const result = await sandbox.execute(code, { store });

    if (result.ok) {
      const writes = result.storeWrites;
      if (Object.keys(writes.set).length > 0 || writes.delete.length > 0) {
        await saveStore(platform, stateDir, store, writes);
      }
    }

    return await formatOutput(platform, result, json);
  } finally {
    await sandbox.close();
  }
}

async function formatOutput(
  platform: Platform,
  result: {
    ok: boolean;
    value?: unknown;
    error?: { message: string };
    output: { type: string; text?: string; console?: boolean }[];
    calls: unknown[];
  },
  json?: boolean
): Promise<number> {
  if (json) {
    const output = {
      ok: result.ok,
      ...(result.ok ? { value: result.value } : { error: result.error }),
      output: result.output,
      calls: result.calls,
    };
    await platform.write(1, `${JSON.stringify(output, null, 2)}\n`);
  } else {
    for (const item of result.output) {
      if (item.type === 'text') {
        await platform.write(item.console ? 2 : 1, `${item.text}\n`);
      }
    }
    if (result.ok && result.value !== undefined && result.value !== null) {
      const val =
        typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2);
      await platform.write(1, `${val}\n`);
    }
    if (!result.ok) {
      await platform.write(2, `mcpcat: script failed: ${result.error!.message}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

async function createSandbox(
  platform: Platform,
  tools: { name: string; description?: string; execute: (args: unknown) => Promise<unknown> }[],
  globals: {
    name: string;
    spread?: boolean;
    signature?: string;
    execute: (args: unknown) => Promise<unknown>;
  }[],
  timeoutMs: number
) {
  const isKernel = platform.packageDir !== undefined;

  if (isKernel) {
    const { InlineCodemodeSandbox } = await import('@earendil-works/pi-codemode/portable');
    const wasm = await loadWasmKernel(platform);
    return new InlineCodemodeSandbox({ tools, globals, timeoutMs, wasm });
  }

  const { CodemodeSandbox, loadQuickJSWasm } = await import('@earendil-works/pi-codemode');
  const wasmPath = await resolveWasmPath(platform);
  return new CodemodeSandbox({
    tools,
    globals,
    timeoutMs,
    wasm: loadQuickJSWasm(wasmPath),
    workerUrl: new URL('./codemode-worker.mjs', import.meta.url),
  });
}

async function resolveWasmPath(platform: Platform): Promise<string> {
  const candidates = [
    new URL('../../quickjs.wasm', import.meta.url),
    new URL('../quickjs.wasm', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = candidate.pathname;
    if (await platform.fs.exists(path)) return path;
  }
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require.resolve('quickjs-wasi/quickjs.wasm');
}

async function loadWasmKernel(platform: Platform): Promise<object> {
  const candidates = [
    ...(platform.packageDir ? [`${platform.packageDir}/dist/quickjs.wasm`] : []),
    `${platform.cwd}/quickjs.wasm`,
    `${platform.env.HOME ?? '.'}/quickjs.wasm`,
  ];

  const wA = globalThis as unknown as { WebAssembly: { compile(b: Uint8Array): Promise<object> } };
  for (const path of candidates) {
    try {
      const bytes = await platform.fs.readFile(path);
      return await wA.WebAssembly.compile(bytes);
    } catch {}
  }

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('quickjs-wasi/quickjs.wasm');
  const { readFile } = await import('node:fs/promises');
  const bytes = new Uint8Array(await readFile(wasmPath));
  return await wA.WebAssembly.compile(bytes);
}

function buildToolSample(
  tool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  qualifiedName: string
): string {
  const id = toCodemodeIdentifier(qualifiedName);
  const desc = tool.description?.trim() ?? '';
  return `${desc}\n\ncodemode tool declaration:\n\`\`\`ts\ndeclare const tools: { ${id}(args: unknown): Promise<unknown>; };\n\`\`\``;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}
