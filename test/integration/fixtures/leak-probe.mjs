export function installLeakProbe(g) {
  const timers = new Map();
  const listeners = new Map();
  const realSet = g.setTimeout;
  const realClear = g.clearTimeout;
  g.setTimeout = function setTimeout(fn, ms, ...rest) {
    let handle;
    const wrapped =
      typeof fn === 'function'
        ? (...a) => {
            timers.delete(handle);
            return fn(...a);
          }
        : fn;
    handle = realSet.call(g, wrapped, ms, ...rest);
    timers.set(handle, Number(ms) || 0);
    return handle;
  };
  g.clearTimeout = function clearTimeout(handle) {
    timers.delete(handle);
    return realClear.call(g, handle);
  };
  const proto = g.EventTarget.prototype;
  const realAdd = proto.addEventListener;
  const realRemove = proto.removeEventListener;
  proto.addEventListener = function addEventListener(type, fn, opts) {
    if (type === 'abort' && this instanceof g.AbortSignal && fn) {
      const set = listeners.get(this) ?? new Set();
      set.add(fn);
      listeners.set(this, set);
    }
    return realAdd.call(this, type, fn, opts);
  };
  proto.removeEventListener = function removeEventListener(type, fn, opts) {
    if (type === 'abort') listeners.get(this)?.delete(fn);
    return realRemove.call(this, type, fn, opts);
  };
  return () => {
    let abortListeners = 0;
    for (const [signal, set] of listeners) if (!signal.aborted) abortListeners += set.size;
    return { timers: [...timers.values()].sort((a, b) => a - b), abortListeners };
  };
}
