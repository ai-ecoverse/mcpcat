import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const command = args.includes('eval-attach')
  ? 'eval-attach'
  : args.includes('eval-file')
    ? 'eval-file'
    : 'eval';
const stateFile = process.env.FAKE_PWCLI_ATTACH_STATE;
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
  const document = (loaderId = 'L1') => {
    emit({ event: 'document-ready', loaderId, early: args.includes('--early') });
    emit({
      event: 'message',
      loaderId,
      payload: { type: 'tools-changed', origin: 'https://shop.example.com', ...snapshot() },
    });
  };
  emit({ event: 'ready', early: args.includes('--early') });
  const armed = () => {
    if (stateFile) writeFileSync(stateFile, 'armed');
    if (process.env.FAKE_PWCLI_ATTACH_LATE || process.env.FAKE_PWCLI_ATTACH_ARM_DELAY)
      emit({ event: 'refused', reason: 'late' });
    else document();
  };
  if (process.env.FAKE_PWCLI_ATTACH_ARM_DELAY)
    setTimeout(armed, Number(process.env.FAKE_PWCLI_ATTACH_ARM_DELAY));
  else armed();
  if (stateFile)
    setInterval(() => {
      if (!existsSync(stateFile) || readFileSync(stateFile, 'utf8') !== 'reload') return;
      writeFileSync(stateFile, 'loaded');
      document('L2');
    }, 20);
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
  const file = command === 'eval-file' ? value('eval-file') : undefined;
  const expression = file ? readFileSync(file, 'utf8') : value('eval');
  record({
    expression,
    file,
    mode: file ? statSync(file).mode & 0o777 : undefined,
    armed: stateFile && existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : undefined,
  });
  if (expression === "'modelContext' in Document.prototype") {
    process.stdout.write(process.env.FAKE_PWCLI_NATIVE ? 'true' : 'false');
  } else if (expression === 'location.reload()') {
    if (stateFile) writeFileSync(stateFile, 'reload');
    process.stdout.write('null');
  } else if (expression.includes('bridge.refresh()')) {
    if (process.env.FAKE_PWCLI_EVAL_INVALID) process.stdout.write('invalid');
    else process.stdout.write(JSON.stringify(snapshot()));
  } else {
    const match = /const request = JSON.parse\((.*)\); const bridge =/.exec(expression);
    const { name, input, allow } = JSON.parse(JSON.parse(match[1]));
    const tool = tools().find((tool) => tool.name === name);
    let result;
    if (process.env.FAKE_PWCLI_CALL_ERROR)
      result = { __webmcp_error: 'threw', message: process.env.FAKE_PWCLI_CALL_ERROR };
    else if (!tool) result = { __webmcp_error: 'unknown' };
    else if (!allow && tool.annotations?.consequentialHint)
      result = { __webmcp_error: 'consequential' };
    else if (process.env.FAKE_PWCLI_CALL_LENGTH)
      result = { __webmcp_result: JSON.stringify({ length: input.productId.length }) };
    else result = { __webmcp_result: `result for ${name}: ${JSON.stringify(input)}` };
    process.stdout.write(JSON.stringify(result));
  }
}
