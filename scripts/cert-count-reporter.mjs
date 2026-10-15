import { relative, resolve } from 'node:path';

export default async function* countPassingTests(source) {
  let passed = 0;
  const perFile = new Map();
  for await (const event of source) {
    const { data } = event;
    const file = data?.file && resolve(data.file);
    if (file && !perFile.has(file)) perFile.set(file, 0);
    if (event.type !== 'test:pass') continue;
    if (data.details?.type !== 'test' || data.skip || data.todo) continue;
    if (file && resolve(data.name) === file) continue;
    passed++;
    if (file) perFile.set(file, perFile.get(file) + 1);
  }
  for (const [file, n] of [...perFile].sort()) {
    yield `cert: file ${relative(process.cwd(), file)} ${n} passed\n`;
  }
  yield `cert: ${passed} tests passed\n`;
}
