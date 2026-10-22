import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

function wsFrame(obj) {
  const data = Buffer.from(JSON.stringify(obj));
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

export async function startFakeCdp({ stall = false } = {}) {
  const seen = [];
  const sessions = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/dialog') {
      for (const socket of sessions) {
        socket.write(
          wsFrame({
            method: 'Page.javascriptDialogOpening',
            sessionId: 'S1',
            params: { type: 'confirm', message: 'Send it?', url: 'https://shop.example.com/' },
          })
        );
      }
      res.end('ok');
      return;
    }
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const upgraded = new Set();
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const masked = (buf[1] & 0x80) !== 0;
        const maskAt = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)];
        buf = buf.subarray(off + len);
        if (op === 8) {
          socket.end();
          return;
        }
        if (op !== 1) continue;
        const msg = JSON.parse(payload.toString());
        seen.push(msg);
        if (msg.method === 'Target.attachToTarget') {
          socket.write(wsFrame({ id: msg.id, result: { sessionId: 'S1' } }));
        } else if (msg.method === 'Page.enable') {
          sessions.add(socket);
          if (!stall) socket.write(wsFrame({ id: msg.id, sessionId: msg.sessionId, result: {} }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () =>
    new Promise((resolve) => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close(resolve);
    });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, dialogUrl: `${url}/dialog`, seen, close };
}
