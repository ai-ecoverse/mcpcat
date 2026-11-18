import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
const tab = args.includes('--tab') ? value('--tab') : 'TAB1';
const session = value('-s');
const work = join(process.env.TMPDIR || '/tmp', session);
const origin = 'https://shop.example.com';
const record = (extra) => {
  if (process.env.FAKE_PWCLI_LOG)
    appendFileSync(
      process.env.FAKE_PWCLI_LOG,
      `${JSON.stringify({ command, argv: args, tab, session, ...extra })}\n`
    );
};
const dir = dirname(fileURLToPath(import.meta.url));
const listedBefore = () =>
  process.env.FAKE_PWCLI_LOG &&
  existsSync(process.env.FAKE_PWCLI_LOG) &&
  readFileSync(process.env.FAKE_PWCLI_LOG, 'utf8').includes('bridge.refresh()');
const useNext = listedBefore();
const tools = () =>
  JSON.parse(
    readFileSync(
      process.env.FAKE_PWCLI_FIXTURE_NEXT && useNext
        ? process.env.FAKE_PWCLI_FIXTURE_NEXT
        : process.env.FAKE_PWCLI_FIXTURE || join(dir, 'webmcp-tools.json'),
      'utf8'
    )
  );
const live = process.env.FAKE_PWCLI_LIVE;
const pageFile = live && `${live}.page.json`;
const page = () => JSON.parse(readFileSync(pageFile, 'utf8'));
const missing =
  process.env.FAKE_PWCLI_TABS && !JSON.parse(process.env.FAKE_PWCLI_TABS).includes(tab);
const snapshot = () =>
  process.env.FAKE_PWCLI_SNAPSHOT_FILE
    ? JSON.parse(readFileSync(process.env.FAKE_PWCLI_SNAPSHOT_FILE, 'utf8'))
    : {
        tools:
          missing || process.env.FAKE_PWCLI_UNAVAILABLE || process.env.FAKE_PWCLI_HOLDER_EMPTY
            ? []
            : live
              ? (page().frames[tab]?.tools ?? []).map((tool) => ({ ...tool, origin }))
              : tools(),
        unavailable: Boolean(process.env.FAKE_PWCLI_UNAVAILABLE),
        mode: 'polyfill',
      };
const childFile = process.env.FAKE_PWCLI_FRAMES;
const frameRecords = () =>
  childFile
    ? JSON.parse(readFileSync(childFile, 'utf8'))
    : live
      ? Object.entries(page().frames)
          .filter(([id]) => id !== tab)
          .map(([frameId, frame]) => ({ frameId, ...frame }))
      : [];
const evidence = (frame) => ({
  frameId: frame.frameId,
  loaderId: frame.loaderId ?? 'LC',
  origin: frame.origin,
  parentFrameId: frame.parentFrameId ?? tab,
  permissionsPolicy: '',
  toolsAllowed: null,
  allow: 'tools *',
  srcOrigin: frame.origin,
  ancestors: [
    {
      frameId: tab,
      loaderId: live ? page().loaderId : 'L1',
      origin,
      permissionsPolicy: '',
      toolsAllowed: null,
      allow: null,
      srcOrigin: null,
    },
  ],
  ...frame.evidence,
});
if (command === 'eval-attach') {
  const file = value('eval-attach');
  record({ file, world: value('--world'), source: readFileSync(file, 'utf8') });
  if (live && !existsSync(pageFile))
    writeFileSync(
      pageFile,
      JSON.stringify({ loaderId: 'L1', frames: JSON.parse(readFileSync(live, 'utf8')).frames })
    );
  const emit = (event) =>
    process.stdout.write(
      `${JSON.stringify({ tab, attachmentId: 'A1', frameId: tab, loaderId: 'L1', ...event })}\n`
    );
  const installed = new Map();
  const frames = () => {
    for (const frame of frameRecords()) {
      const document = evidence(frame);
      if (installed.get(frame.frameId) !== document.loaderId) {
        installed.set(frame.frameId, document.loaderId);
        emit({ event: 'document-ready', early: false, ...document });
      }
      emit({
        event: 'message',
        ...evidence(frame),
        payload: { type: 'tools-changed', tools: frame.tools ?? [] },
      });
    }
  };
  const document = (loaderId = 'L1') => {
    installed.clear();
    emit({ event: 'document-ready', loaderId, early: args.includes('--early') });
    emit({ event: 'message', loaderId, payload: { type: 'tools-changed', origin, ...snapshot() } });
    frames();
  };
  emit({ event: 'ready', early: args.includes('--early') });
  const armed = () => {
    if (stateFile) writeFileSync(stateFile, 'armed');
    if (process.env.FAKE_PWCLI_ATTACH_LATE || process.env.FAKE_PWCLI_ATTACH_ARM_DELAY)
      emit({ event: 'refused', reason: 'late' });
    else document();
    if (process.env.FAKE_PWCLI_CROSS_ORIGIN_OFF)
      emit({
        event: 'refused',
        frameId: 'CHILD',
        parentFrameId: tab,
        reason: 'cross-origin child tools are unavailable',
      });
  };
  if (process.env.FAKE_PWCLI_ATTACH_ARM_DELAY)
    setTimeout(armed, Number(process.env.FAKE_PWCLI_ATTACH_ARM_DELAY));
  else armed();
  let next = 0;
  setInterval(() => {
    if (stateFile && existsSync(stateFile) && readFileSync(stateFile, 'utf8') === 'reload') {
      writeFileSync(stateFile, 'loaded');
      document('L2');
    }
    for (const name of readdirSync(work).filter((name) => name.startsWith('refresh-'))) {
      const request = JSON.parse(readFileSync(join(work, name), 'utf8'));
      rmSync(join(work, name));
      const frame = frameRecords().find((frame) => frame.frameId === request.frame);
      if (frame)
        emit({
          event: 'message',
          ...evidence(frame),
          payload: { type: 'tools-changed', tools: frame.tools ?? [], requestId: request.id },
        });
    }
    if (live && existsSync(`${live}.step${next}`)) {
      const step = JSON.parse(readFileSync(live, 'utf8')).steps[next++];
      const state = page();
      if (step.navigate) {
        writeFileSync(pageFile, JSON.stringify({ loaderId: step.navigate, frames: step.frames }));
        document(step.navigate);
      } else {
        state.frames[step.frame] = {
          origin: step.origin,
          tools: step.tools,
          loaderId: step.loaderId,
        };
        writeFileSync(pageFile, JSON.stringify(state));
        if (step.frame === tab)
          emit({
            event: 'message',
            loaderId: state.loaderId,
            payload: { type: 'tools-changed', origin, ...snapshot() },
          });
        else frames();
      }
    }
  }, 20);
  if (process.env.FAKE_PWCLI_ATTACH_REFRESH) {
    let last = JSON.stringify(snapshot());
    setInterval(() => {
      const now = JSON.stringify(snapshot());
      if (now === last) return;
      last = now;
      emit({ event: 'message', payload: { type: 'tools-changed', origin, ...snapshot() } });
    }, 30);
  }
  if (process.env.FAKE_PWCLI_ATTACH_EXIT)
    setTimeout(() => process.exit(Number(process.env.FAKE_PWCLI_ATTACH_EXIT)), 100);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.on('end', resolve));
  record({ stopped: true });
  process.exit(0);
} else {
  const file = command === 'eval-file' ? value('eval-file') : undefined;
  const expression = file ? readFileSync(file, 'utf8') : value('eval');
  const request = file
    ? JSON.parse(
        JSON.parse(/const request = JSON.parse\((.*)\); const bridge =/.exec(expression)[1])
      )
    : undefined;
  record({
    tool: request?.name,
    executedOrigin: request?.origin,
    expression,
    file,
    mode: file ? statSync(file).mode & 0o777 : undefined,
    armed: stateFile && existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : undefined,
  });
  if (expression === "'modelContext' in Document.prototype")
    process.stdout.write(process.env.FAKE_PWCLI_NATIVE ? 'true' : 'false');
  else if (expression === 'location.reload()') {
    if (stateFile) writeFileSync(stateFile, 'reload');
    process.stdout.write('null');
  } else if (expression.includes('?.dispose()')) process.stdout.write('null');
  else if (expression.includes('?.refresh(')) {
    const id = JSON.parse(/refresh\((.*)\)/.exec(expression)[1]);
    writeFileSync(
      join(work, `refresh-${value('--frame')}`),
      JSON.stringify({ id, frame: value('--frame') })
    );
    process.stdout.write('{}');
  } else if (expression.includes('bridge.refresh()')) {
    if (process.env.FAKE_PWCLI_HANG_LIST) {
      if (process.env.FAKE_PWCLI_DIALOG_URL) await fetch(process.env.FAKE_PWCLI_DIALOG_URL);
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    if (process.env.FAKE_PWCLI_EVAL_INVALID) process.stdout.write('invalid');
    else process.stdout.write(JSON.stringify(snapshot()));
  } else {
    const match = /const request = JSON.parse\((.*)\); const bridge =/.exec(expression);
    const { name, input, allow } = JSON.parse(JSON.parse(match[1]));
    const tool = (
      live
        ? Object.values(page().frames).flatMap((frame) => frame.tools)
        : [...tools(), ...frameRecords().flatMap((frame) => frame.tools)]
    ).find((tool) => tool.name === name);
    if (process.env.FAKE_PWCLI_HANG) {
      if (process.env.FAKE_PWCLI_DIALOG_URL) await fetch(process.env.FAKE_PWCLI_DIALOG_URL);
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    if (process.env.FAKE_PWCLI_CALL_DIALOG) {
      const dialog = process.env.FAKE_PWCLI_DIALOG_DIR;
      writeFileSync(join(dialog, 'open'), process.env.FAKE_PWCLI_CALL_DIALOG);
      while (existsSync(join(dialog, 'open')))
        await new Promise((resolve) => setTimeout(resolve, 20));
      process.stdout.write(
        JSON.stringify({
          __webmcp_result: `result for ${name} after the dialog was ${readFileSync(join(dialog, 'answer'), 'utf8')}`,
        })
      );
      process.exit(0);
    }
    let result;
    if (process.env.FAKE_PWCLI_EXIT_CODE) process.exit(Number(process.env.FAKE_PWCLI_EXIT_CODE));
    if (process.env.FAKE_PWCLI_CALL_ERROR)
      result = { __webmcp_error: 'threw', message: process.env.FAKE_PWCLI_CALL_ERROR };
    else if (!tool) result = { __webmcp_error: 'unknown' };
    else if (!allow && tool.annotations?.consequentialHint)
      result = { __webmcp_error: 'consequential' };
    else if (process.env.FAKE_PWCLI_CALL_LENGTH)
      result = { __webmcp_result: JSON.stringify({ length: input.productId.length }) };
    else if (process.env.FAKE_PWCLI_BIG)
      result = { __webmcp_result: 'x'.repeat(Number(process.env.FAKE_PWCLI_BIG)) };
    else
      result = {
        __webmcp_result: `result for ${name} on ${tool.origin}: ${JSON.stringify(input)}`,
      };
    process.stdout.write(JSON.stringify(result));
  }
}
