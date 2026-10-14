const AUTHORIZE = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/;

export function waitForAuthorizeUrl(proc, stderr, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      proc.stderr.off('data', check);
      proc.off('exit', exited);
      fn(value);
    };
    const check = () => {
      const match = stderr().match(AUTHORIZE);
      if (match) done(resolve, match[1]);
    };
    const exited = (code) => {
      setImmediate(() => {
        const match = stderr().match(AUTHORIZE);
        if (match) done(resolve, match[1]);
        else done(reject, new Error(`login exited ${code} before an authorize URL: ${stderr()}`));
      });
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      done(reject, new Error(`No authorize URL: ${stderr()}`));
    }, timeoutMs);
    proc.stderr.on('data', check);
    proc.on('exit', exited);
    check();
  });
}
