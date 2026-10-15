#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const listedBefore = () =>
  Boolean(process.env.FAKE_PWCLI_LOG) &&
  existsSync(process.env.FAKE_PWCLI_LOG) &&
  readFileSync(process.env.FAKE_PWCLI_LOG, 'utf8').includes('"command":"webmcp-list"');
const fixtureFile =
  process.env.FAKE_PWCLI_FIXTURE_NEXT && listedBefore()
    ? process.env.FAKE_PWCLI_FIXTURE_NEXT
    : process.env.FAKE_PWCLI_FIXTURE || join(dir, 'webmcp-tools.json');

if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write('playwright-cli 1.21.1-fake\n');
  process.exit(0);
}

let cdp;
let tab;
const filtered = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cdp' && args[i + 1]) {
    cdp = args[++i];
  } else if (args[i] === '--tab' && args[i + 1]) {
    tab = args[++i];
  } else {
    filtered.push(args[i]);
  }
}

const command = filtered[0];

const tabIds = process.env.FAKE_PWCLI_TABS ? JSON.parse(process.env.FAKE_PWCLI_TABS) : ['TAB1'];
const stateFile = process.env.FAKE_PWCLI_STATE;
const currentTab = () => {
  if (stateFile && existsSync(stateFile))
    return readFileSync(stateFile, 'utf8').trim() || undefined;
  return process.env.FAKE_PWCLI_NO_CURRENT ? undefined : tabIds[0];
};
const record = (entry) => {
  if (process.env.FAKE_PWCLI_LOG) {
    appendFileSync(process.env.FAKE_PWCLI_LOG, `${JSON.stringify({ argv: args, ...entry })}\n`);
  }
};
const drift = () => {
  if (stateFile && process.env.FAKE_PWCLI_DRIFT) {
    const now = currentTab();
    const next = tabIds[(tabIds.indexOf(now) + 1) % tabIds.length];
    writeFileSync(stateFile, next);
  }
};
const usedTab = () => tab ?? currentTab();

if (command === 'tab-list') {
  record({ command });
  if (tabIds.length === 0) {
    process.stdout.write('No tabs open\n');
    process.exit(0);
  }
  const now = currentTab();
  const lines = tabIds.map(
    (id, i) =>
      `${i + 1}: [${id}] https://shop.example.com/${i} "Tab ${i + 1}"${id === now ? ' (active)' : ''}`
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

if (command === 'webmcp-list') {
  const json = filtered.includes('--json');
  if (!json) {
    process.stderr.write('webmcp-list requires --json\n');
    process.exit(2);
  }
  record({ command, tab: usedTab() });
  drift();
  try {
    const data = readFileSync(fixtureFile, 'utf8');
    process.stdout.write(data);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`fixture not found: ${fixtureFile}\n`);
    process.exit(2);
  }
}

if (command === 'webmcp-call') {
  const toolName = filtered[1];
  const stdinFlag = filtered[2];
  const allowConsequential = filtered.includes('--allow-consequential');

  if (!toolName || stdinFlag !== '-') {
    process.stderr.write('usage: webmcp-call <name> -\n');
    process.exit(2);
  }

  let tools;
  try {
    tools = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  } catch {
    process.stderr.write('no fixture\n');
    process.exit(2);
  }

  const tool = tools.find((t) => t.name === toolName);
  record({ command, tab: usedTab(), tool: toolName, executedOrigin: tool?.origin });
  drift();
  if (!tool) {
    process.stderr.write(`unknown tool: ${toolName}\n`);
    process.exit(2);
  }

  if (tool.annotations?.consequentialHint && !allowConsequential) {
    process.stderr.write('consequential tool requires --allow-consequential\n');
    process.exit(2);
  }

  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const stdinData = chunks.join('');
    let input;
    try {
      input = JSON.parse(stdinData);
    } catch {
      process.stderr.write('invalid JSON on stdin\n');
      process.exit(2);
      return;
    }

    if (process.env.FAKE_PWCLI_ECHO_CALL) {
      const callLog = JSON.stringify({
        tool: toolName,
        input,
        argv: process.argv.slice(2),
        stdinUsed: true,
        cdp,
        tab,
        allowConsequential,
      });
      process.stderr.write(`CALL_LOG:${callLog}\n`);
    }

    if (process.env.FAKE_PWCLI_EXIT_CODE) {
      const code = Number(process.env.FAKE_PWCLI_EXIT_CODE);
      if (code === 1) {
        process.stderr.write('tool threw an error\n');
        process.exit(1);
      }
      process.exit(code);
    }

    if (process.env.FAKE_PWCLI_BIG) {
      const big = Number(process.env.FAKE_PWCLI_BIG);
      const chunk = 'x'.repeat(65536);
      let left = big;
      const pump = () => {
        while (left > 0) {
          const piece = chunk.slice(0, Math.min(left, chunk.length));
          left -= piece.length;
          if (!process.stdout.write(piece)) {
            process.stdout.once('drain', pump);
            return;
          }
        }
        process.stdout.end(() => process.exit(0));
      };
      pump();
      return;
    }

    process.stdout.write(`result for ${toolName} on ${tool.origin}: ${JSON.stringify(input)}`);
    process.exit(0);
  });
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
