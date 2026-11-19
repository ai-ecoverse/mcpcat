#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('eval-attach') || args.includes('eval') || args.includes('eval-file')) {
  await import('./fake-webmcp-attach.mjs');
  await new Promise((resolve) => process.stdout.end(resolve));
  process.exit(0);
}

if (args[0] === '--version' || args[0] === '-V') {
  if (process.env.FAKE_PWCLI_VERSION === 'fail') process.exit(1);
  process.stdout.write(`playwright-cli ${process.env.FAKE_PWCLI_VERSION || '1.54.0'}-fake\n`);
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

if (command !== 'tab-list' && command !== 'dialog-hold') {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
