import { appendFileSync } from 'node:fs';
import net from 'node:net';

const log = process.env.LISTEN_PROBE_LOG;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (log) {
    const options = args.filter((a) => typeof a !== 'function');
    appendFileSync(log, `${JSON.stringify(options)}\n`);
  }
  return listen.apply(this, args);
};
