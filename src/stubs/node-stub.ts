export default {};
export function spawn() {
  throw new Error('not available in kernel');
}
export function createInterface() {
  throw new Error('not available in kernel');
}
export const constants = { F_OK: 0 };
export function access() {
  throw new Error('not available in kernel');
}
export function readFile() {
  throw new Error('not available in kernel');
}
export function writeFile() {
  throw new Error('not available in kernel');
}
export function mkdir() {
  throw new Error('not available in kernel');
}
export function rename() {
  throw new Error('not available in kernel');
}
export function stat() {
  throw new Error('not available in kernel');
}
export function isatty() {
  return false;
}
export const Readable = {
  toWeb() {
    throw new Error('not available in kernel');
  },
};
export const Writable = {
  toWeb() {
    throw new Error('not available in kernel');
  },
};
export const Stream = {};
export function resolve() {
  return '';
}
export function join() {
  return '';
}
export function dirname() {
  return '';
}
export function basename() {
  return '';
}
export function fileURLToPath() {
  return '';
}
export function pathToFileURL() {
  return '';
}
export const env = {};
export const pid = 0;
export const platform = 'kernel';
export function homedir() {
  return '';
}
export function tmpdir() {
  return '';
}
export class EventEmitter {}
export function inherits() {}
export function promisify() {
  return () => {};
}
export function deprecate() {
  return () => {};
}
export function createRequire() {
  return () => '';
}
export class Worker {
  constructor() {
    throw new Error('not available in kernel');
  }
}
export const workerData = null;
export const parentPort = null;
