import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_ATTACH_LOG)
    appendFileSync(process.env.FAKE_ATTACH_LOG, `${JSON.stringify({ argv: args, ...entry })}\n`);
};
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === '--version') {
  process.stdout.write(`playwright-cli ${process.env.FAKE_ATTACH_VERSION ?? '1.51.0'}\n`);
  process.exit(0);
}

const command = args.find((a) => ['eval-attach', 'eval', 'tab-list'].includes(a));

if (command === 'tab-list') {
  process.stdout.write('1: [TAB1] http://localhost:4789/ "Demo" (active)\n');
  process.exit(0);
}

if (command === 'eval') {
  const expression = args[args.indexOf('eval') + 1];
  log({ command: 'eval', expression, tab: value('--tab') });
  process.stdout.write(`${process.env.FAKE_ATTACH_EVAL ?? '{"accepted":true}'}\n`);
  process.exit(0);
}

if (command === 'eval-attach') {
  const file = args[args.indexOf('eval-attach') + 1];
  const world = value('--world');
  const source = readFileSync(file, 'utf8');
  log({ command: 'eval-attach', world, file, session: value('-s'), bytes: source.length });
  if (process.env.FAKE_ATTACH_REFUSE === world) {
    process.stderr.write('eval-attach: refused\n');
    process.exit(2);
  }
  const attachmentId = `eval-${world}`;
  const tab = 'TAB1';
  out({ event: 'ready', attachmentId, world, early: false });
  out({
    event: 'document-ready',
    attachmentId,
    tab,
    frameId: tab,
    loaderId: 'L1',
    url: 'http://localhost:4789/',
    world,
    early: false,
  });
  if (world === 'main' && process.env.FAKE_ATTACH_LATE)
    out({ event: 'refused', attachmentId, tab, reason: 'late' });
  if (world === 'isolated') {
    const messages = JSON.parse(
      process.env.FAKE_ATTACH_MESSAGES_FILE
        ? readFileSync(process.env.FAKE_ATTACH_MESSAGES_FILE, 'utf8')
        : (process.env.FAKE_ATTACH_MESSAGES ?? '[]')
    );
    const delay = Number(process.env.FAKE_ATTACH_DELAY ?? '0');
    setTimeout(() => {
      for (const payload of messages)
        out({ event: 'message', attachmentId, tab, frameId: tab, loaderId: 'L1', payload });
    }, delay);
  }
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    out({ event: 'stopped', attachmentId, reason: 'stdin' });
    log({ command: 'stopped', world });
    process.exit(0);
  });
} else {
  process.stderr.write(`fake: unsupported ${args.join(' ')}\n`);
  process.exit(2);
}
