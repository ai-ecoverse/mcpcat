interface Feature {
  summary: string;
  revision: string;
}

export const EXPERIMENTAL_FEATURES: Record<string, Feature> = {
  events: {
    summary: 'MCP Events client, poll and push (SEP-3415)',
    revision: 'SEP-3415 at modelcontextprotocol/modelcontextprotocol@b0efd116faca',
  },
};

const KNOWN = Object.keys(EXPERIMENTAL_FEATURES).join(', ');

export interface ExperimentalArgs {
  features: Set<string>;
  args: string[];
  error?: string;
}

function addFeatures(value: string, features: Set<string>): string | undefined {
  const names = value.split(',').map((n) => n.trim());
  if (names.length === 0 || names.some((n) => !n)) {
    return `--experimental needs a feature name (known: ${KNOWN})`;
  }
  for (const name of names) {
    if (!Object.hasOwn(EXPERIMENTAL_FEATURES, name)) {
      return `unknown experimental feature '${name}' (known: ${KNOWN})`;
    }
    features.add(name);
  }
  return undefined;
}

export function extractExperimental(args: string[]): ExperimentalArgs {
  const features = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' || arg === '--subscribe') {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith('--experimental=')) {
      const error = addFeatures(arg.slice('--experimental='.length), features);
      if (error) return { features, args, error };
      continue;
    }
    if (arg === '--experimental') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { features, args, error: `--experimental needs a feature name (known: ${KNOWN})` };
      }
      const error = addFeatures(value, features);
      if (error) return { features, args, error };
      i++;
      continue;
    }
    out.push(arg);
  }
  return { features, args: out };
}

export function experimentalHelp(verbose = false): string {
  const pad = ' '.repeat(29);
  return Object.entries(EXPERIMENTAL_FEATURES)
    .map(([name, f]) => {
      const line = `  ${name.padEnd(26)} ${f.summary}\n`;
      return verbose ? `${line}${pad}${f.revision}\n` : line;
    })
    .join('');
}
