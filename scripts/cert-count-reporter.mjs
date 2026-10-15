import { resolve } from 'node:path';

export default async function* countPassingTests(source) {
  let passed = 0;
  for await (const event of source) {
    if (event.type !== 'test:pass') continue;
    const { data } = event;
    if (data.details?.type !== 'test' || data.skip || data.todo) continue;
    if (data.file && resolve(data.name) === data.file) continue;
    passed++;
  }
  yield `cert: ${passed} tests passed\n`;
}
