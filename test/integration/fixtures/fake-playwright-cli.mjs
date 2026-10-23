#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (process.env.FAKE_PWCLI_VERSION === 'fail') process.exit(1);
  process.stdout.write(`playwright-cli ${process.env.FAKE_PWCLI_VERSION || '1.32.0'}-fake\n`);
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

const holderFile = process.env.FAKE_PWCLI_HOLDER_FILE;
const holderUp = () => Boolean(holderFile) && existsSync(holderFile);
const holderRuns = () =>
  process.env.FAKE_PWCLI_LOG && existsSync(process.env.FAKE_PWCLI_LOG)
    ? readFileSync(process.env.FAKE_PWCLI_LOG, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"command":"webmcp-polyfill"')).length
    : 1;

const dialogDir = process.env.FAKE_PWCLI_DIALOG_DIR;
const dialogOpen = () => Boolean(dialogDir) && existsSync(join(dialogDir, 'open'));
const holdRuns = () =>
  process.env.FAKE_PWCLI_LOG && existsSync(process.env.FAKE_PWCLI_LOG)
    ? readFileSync(process.env.FAKE_PWCLI_LOG, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"command":"dialog-hold"')).length
    : 1;

if (command === 'dialog-hold') {
  record({ command, tab, cdp });
  if (process.env.FAKE_PWCLI_HOLD_FAIL) {
    process.stderr.write('dialog-hold: cannot attach\n');
    process.exit(2);
  }
  const emit = (event) => process.stdout.write(`${JSON.stringify({ target: tab, ...event })}\n`);
  let preexisting = dialogOpen();
  let dialogId = 0;
  let announced;
  emit({ event: 'ready', loaderId: null, loaderIdSource: 'unavailable', status: 'observing' });
  const stop = (reason, code) => {
    emit({ event: 'stopped', reason });
    process.exit(code);
  };
  setInterval(() => {
    const open = dialogOpen();
    if (!open) preexisting = false;
    if (open && !preexisting && announced === undefined) {
      announced = ++dialogId;
      emit({
        event: process.env.FAKE_PWCLI_HOLD_REFUSE ? 'dialog-refused' : 'dialog-opened',
        dialogId: announced,
      });
    } else if (!open && announced !== undefined) {
      emit({ event: 'dialog-closed', dialogId: announced });
      announced = undefined;
    }
  }, 50);
  if (process.env.FAKE_PWCLI_HOLD_EXIT_FIRST && holdRuns() === 1) {
    setTimeout(() => {
      process.stderr.write('dialog-hold: target closed, changed or refused\n');
      stop('target closed, changed or refused', 1);
    }, Number(process.env.FAKE_PWCLI_HOLD_EXIT_FIRST));
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      record({ command: 'dialog-hold-request', request });
      if (process.env.FAKE_PWCLI_HOLD_SILENT) continue;
      if (announced === undefined || !dialogOpen()) {
        emit({ event: 'no-dialog', id: request.id });
      } else if (request.dialogId !== announced) {
        emit({ event: 'stale-dialog', id: request.id, dialogId: request.dialogId });
      } else if (process.env.FAKE_PWCLI_HOLD_REFUSE) {
        emit({ event: 'dialog-refused', id: request.id, dialogId: request.dialogId });
      } else {
        const accept = request.command === 'dialog-accept';
        writeFileSync(join(dialogDir, 'answer'), accept ? 'accepted' : 'dismissed');
        rmSync(join(dialogDir, 'open'));
        emit({ event: 'handled', id: request.id, dialogId: request.dialogId, accept });
      }
    }
  });
  process.stdin.on('end', () => stop('stdin-eof', 0));
} else if (command === 'webmcp-polyfill') {
  const reload = filtered.includes('--reload');
  record({ command, tab, reload });
  const mode = process.env.FAKE_PWCLI_HOLDER || 'native';
  if (mode === 'fail') {
    process.stderr.write('webmcp-polyfill: cannot attach\n');
    process.exit(2);
  }
  const emit = (event) => process.stdout.write(`${JSON.stringify({ tab, ...event })}\n`);
  if (mode !== 'native' && holderFile) writeFileSync(holderFile, String(process.pid));
  emit({ event: 'ready', loaderId: 'L1', mode, late: !reload, reloaded: reload });
  const stop = (code) => {
    if (holderUp() && readFileSync(holderFile, 'utf8') === String(process.pid)) rmSync(holderFile);
    process.exit(code);
  };
  if (process.env.FAKE_PWCLI_HOLDER_EXIT_ALWAYS) {
    setTimeout(() => {
      process.stderr.write('webmcp-polyfill: target closed\n');
      stop(1);
    }, Number(process.env.FAKE_PWCLI_HOLDER_EXIT_ALWAYS));
  }
  if (process.env.FAKE_PWCLI_HOLDER_EXIT_FIRST && holderRuns() === 1) {
    setTimeout(() => {
      process.stderr.write('webmcp-polyfill: target closed, changed or was refused by the guard\n');
      stop(1);
    }, Number(process.env.FAKE_PWCLI_HOLDER_EXIT_FIRST));
  }
  if (process.env.FAKE_PWCLI_HOLDER_NAVIGATE) {
    setTimeout(
      () => emit({ event: 'document-ready', loaderId: 'L2' }),
      Number(process.env.FAKE_PWCLI_HOLDER_NAVIGATE)
    );
  }
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    record({ command: 'webmcp-polyfill-stdin-closed', tab });
    stop(0);
  });
  setInterval(() => {}, 1000);
} else if (command === 'tab-list') {
  record({ command });
  if (process.env.FAKE_PWCLI_TAB_LIST_FAIL) {
    process.stderr.write('boom \x1b]0;pwned\x07 \x1b[2J \x9b31m end\n');
    process.exit(1);
  }
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
  record({ command, tab: usedTab(), holder: holderUp() });
  drift();
  if (process.env.FAKE_PWCLI_UNAVAILABLE || (process.env.FAKE_PWCLI_NEEDS_HOLDER && !holderUp())) {
    process.stderr.write(
      'webmcp-list: WebMCP is unavailable on this page (document.modelContext is absent)\n'
    );
    process.exit(2);
  } else if (process.env.FAKE_PWCLI_HOLDER_EMPTY && holderUp()) {
    process.stdout.write('[]\n');
    process.exit(0);
  } else if (process.env.FAKE_PWCLI_HANG_LIST) {
    if (process.env.FAKE_PWCLI_DIALOG_URL) fetch(process.env.FAKE_PWCLI_DIALOG_URL).catch(() => {});
    setInterval(() => {}, 1000);
  } else if (tab && !tabIds.includes(tab)) {
    process.stdout.write('[]\n');
    process.exit(0);
  } else {
    try {
      const data = readFileSync(fixtureFile, 'utf8');
      process.stdout.write(data);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`fixture not found: ${fixtureFile}\n`);
      process.exit(2);
    }
  }
} else if (command === 'webmcp-call') {
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

    if (process.env.FAKE_PWCLI_CALL_DIALOG) {
      writeFileSync(join(dialogDir, 'open'), process.env.FAKE_PWCLI_CALL_DIALOG);
      const wait = setInterval(() => {
        if (dialogOpen()) return;
        clearInterval(wait);
        const answer = readFileSync(join(dialogDir, 'answer'), 'utf8');
        process.stdout.write(`result for ${toolName} after the dialog was ${answer}`);
        process.exit(0);
      }, 50);
      return;
    }

    if (process.env.FAKE_PWCLI_HANG) {
      if (process.env.FAKE_PWCLI_DIALOG_URL)
        fetch(process.env.FAKE_PWCLI_DIALOG_URL).catch(() => {});
      setInterval(() => {}, 1000);
      return;
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
} else if (command !== 'webmcp-polyfill' && command !== 'dialog-hold') {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
