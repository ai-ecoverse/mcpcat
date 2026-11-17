import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const command = args.includes('eval-attach') ? 'eval-attach' : 'eval';
const tab = value('--tab');
const record = (extra) => {
  if (process.env.FAKE_PWCLI_LOG)
    appendFileSync(
      process.env.FAKE_PWCLI_LOG,
      `${JSON.stringify({ command, argv: args, tab, ...extra })}\n`
    );
};
const dir = dirname(fileURLToPath(import.meta.url));
const tools = () =>
  JSON.parse(
    readFileSync(process.env.FAKE_PWCLI_FIXTURE || join(dir, 'webmcp-tools.json'), 'utf8')
  );
const snapshot = () => ({
  tools: process.env.FAKE_PWCLI_UNAVAILABLE ? [] : tools(),
  unavailable: Boolean(process.env.FAKE_PWCLI_UNAVAILABLE),
  mode: 'polyfill',
});
if (command === 'eval-attach') {
  const file = value('eval-attach');
  record({
    file,
    world: value('--world'),
    session: value('-s'),
    source: readFileSync(file, 'utf8'),
  });
  const emit = (event) =>
    process.stdout.write(`${JSON.stringify({ tab, frameId: tab, loaderId: 'L1', ...event })}\n`);
  const document = () => {
    emit({ event: 'document-ready', early: args.includes('--early') });
    emit({
      event: 'message',
      payload: { type: 'tools-changed', origin: 'https://shop.example.com', ...snapshot() },
    });
  };
  emit({ event: 'ready', early: args.includes('--early') });
  if (process.env.FAKE_PWCLI_ATTACH_LATE) emit({ event: 'refused', reason: 'late' });
  else document();
  if (process.env.FAKE_PWCLI_ATTACH_REFRESH) {
    let last = '';
    setInterval(() => {
      const now = JSON.stringify(snapshot());
      if (now === last) return;
      last = now;
      emit({
        event: 'message',
        payload: { type: 'tools-changed', origin: 'https://shop.example.com', ...snapshot() },
      });
    }, 30);
  }
  if (process.env.FAKE_PWCLI_ATTACH_EXIT) {
    setTimeout(() => process.exit(Number(process.env.FAKE_PWCLI_ATTACH_EXIT)), 100);
  }
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.on('end', resolve));
  record({ stopped: true });
} else {
  const expression = value('eval');
  record({ expression });
  if (expression === "'modelContext' in Document.prototype") {
    process.stdout.write(process.env.FAKE_PWCLI_NATIVE ? 'true' : 'false');
  } else if (expression === 'location.reload()') {
    process.stdout.write('null');
  } else if (expression.includes('bridge.refresh()')) {
    if (process.env.FAKE_PWCLI_EVAL_INVALID) process.stdout.write('invalid');
    else process.stdout.write(JSON.stringify(snapshot()));
  } else {
    const match = /await bridge.call\((.*)\) :/.exec(expression);
    const [name, input, allow] = JSON.parse(`[${match[1]}]`);
    const tool = tools().find((tool) => tool.name === name);
    let result;
    if (process.env.FAKE_PWCLI_CALL_ERROR)
      result = { __webmcp_error: 'threw', message: process.env.FAKE_PWCLI_CALL_ERROR };
    else if (!tool) result = { __webmcp_error: 'unknown' };
    else if (!allow && tool.annotations?.consequentialHint)
      result = { __webmcp_error: 'consequential' };
    else result = { __webmcp_result: `result for ${name}: ${JSON.stringify(input)}` };
    process.stdout.write(JSON.stringify(result));
  }
}
