const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_HEADER_SIZE = 16_384;
const MAX_BODY_SIZE = 10_485_760;

export interface HttpRequest {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: string;
}

export type HttpHandler = (request: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

interface ChunkReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
}

export async function readUntil(
  reader: ChunkReader,
  buf: Uint8Array<ArrayBuffer>,
  bufLen: number,
  sentinel: string,
  maxSize: number
): Promise<{ buf: Uint8Array<ArrayBuffer>; bufLen: number; pos: number } | null> {
  for (;;) {
    const text = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, bufLen));
    const pos = text.indexOf(sentinel);
    if (pos >= 0) return { buf, bufLen, pos };
    if (bufLen >= maxSize) return null;
    const { done, value } = await reader.read();
    if (done) return null;
    if (bufLen + value.length > buf.length) {
      const newBuf = new Uint8Array(Math.max(buf.length * 2, bufLen + value.length));
      newBuf.set(new Uint8Array(buf.buffer, buf.byteOffset, bufLen));
      buf = newBuf;
    }
    buf.set(value, bufLen);
    bufLen += value.length;
  }
}

export async function readExact(
  reader: ChunkReader,
  buf: Uint8Array<ArrayBuffer>,
  bufLen: number,
  needed: number
): Promise<{ buf: Uint8Array<ArrayBuffer>; bufLen: number } | null> {
  while (bufLen < needed) {
    const { done, value } = await reader.read();
    if (done) return null;
    if (bufLen + value.length > buf.length) {
      const newBuf = new Uint8Array(Math.max(buf.length * 2, bufLen + value.length));
      newBuf.set(new Uint8Array(buf.buffer, buf.byteOffset, bufLen));
      buf = newBuf;
    }
    buf.set(value, bufLen);
    bufLen += value.length;
  }
  return { buf, bufLen };
}

function parseRequestLine(
  buf: Uint8Array,
  endPos: number
): { method: string; target: string; headers: Record<string, string>; headerEnd: number } | null {
  const headText = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, endPos));
  const lines = headText.split('\r\n');
  const requestLine = lines[0];
  if (!requestLine) return null;
  const parts = requestLine.split(' ');
  if (parts.length < 2) return null;
  const method = parts[0];
  const target = parts[1];
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
  }
  return { method, target, headers, headerEnd: endPos + 4 };
}

export async function handleConnection(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  handler: HttpHandler
): Promise<void> {
  const raw = readable.getReader();
  let ahead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const parked: ReadableStreamReadResult<Uint8Array>[] = [];
  const reader: ChunkReader = {
    read() {
      const queued = parked.shift();
      if (queued) return Promise.resolve(queued);
      const next = ahead ?? raw.read();
      ahead = null;
      return next;
    },
  };
  const watch = async (live: { on: boolean }, disconnect: AbortController) => {
    let held = 0;
    while (held <= MAX_HEADER_SIZE + MAX_BODY_SIZE) {
      const pending: Promise<ReadableStreamReadResult<Uint8Array>> = ahead ?? raw.read();
      ahead = pending;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await pending;
      } catch {
        if (live.on) disconnect.abort();
        return;
      }
      if (!live.on) return;
      ahead = null;
      parked.push(result);
      if (result.done) {
        disconnect.abort();
        return;
      }
      held += result.value.length;
    }
  };
  const writer = writable.getWriter();
  let buf = new Uint8Array(4096);
  let bufLen = 0;

  try {
    for (;;) {
      const headerResult = await readUntil(reader, buf, bufLen, '\r\n\r\n', MAX_HEADER_SIZE);
      if (!headerResult) break;
      buf = headerResult.buf;
      bufLen = headerResult.bufLen;

      const parsed = parseRequestLine(buf, headerResult.pos);
      if (!parsed) {
        await writeResponse(writer, {
          status: 400,
          reason: 'Bad Request',
          headers: { 'content-type': 'text/plain' },
          body: 'Bad Request',
        });
        break;
      }

      const contentLength = Number(parsed.headers['content-length'] ?? 0);
      if (contentLength > MAX_BODY_SIZE) {
        await writeResponse(writer, {
          status: 413,
          reason: 'Payload Too Large',
          headers: { 'content-type': 'text/plain' },
          body: 'Payload Too Large',
        });
        break;
      }

      const bodyStart = parsed.headerEnd;
      const totalNeeded = bodyStart + contentLength;
      const bodyResult = await readExact(reader, buf, bufLen, totalNeeded);
      if (!bodyResult && contentLength > 0) break;
      if (bodyResult) {
        buf = bodyResult.buf;
        bufLen = bodyResult.bufLen;
      }

      const bodyBytes = buf.slice(bodyStart, bodyStart + contentLength);
      const body = decoder.decode(bodyBytes);

      const request: HttpRequest = {
        method: parsed.method,
        target: parsed.target,
        headers: parsed.headers,
        body,
      };

      const disconnect = new AbortController();
      const live = { on: true };
      void watch(live, disconnect);
      let response: HttpResponse;
      try {
        response = await handler(request, disconnect.signal);
      } finally {
        live.on = false;
      }
      if (disconnect.signal.aborted) break;
      await writeResponse(writer, response);

      const connectionHeader = (parsed.headers.connection ?? '').toLowerCase();
      if (connectionHeader === 'close') break;

      const consumed = bodyStart + contentLength;
      const remaining = bufLen - consumed;
      if (remaining > 0) {
        const newBuf = new Uint8Array(Math.max(4096, remaining));
        newBuf.set(new Uint8Array(buf.buffer, buf.byteOffset + consumed, remaining));
        buf = newBuf;
        bufLen = remaining;
      } else {
        buf = new Uint8Array(4096);
        bufLen = 0;
      }
    }
  } finally {
    raw.releaseLock();
    try {
      await writer.close();
    } catch {}
  }
}

async function writeResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  response: HttpResponse
): Promise<void> {
  const bodyLength = new TextEncoder().encode(response.body).length;
  const headers = { ...response.headers, 'content-length': String(bodyLength) };
  const lines = [`HTTP/1.1 ${response.status} ${response.reason}`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push('', '');
  const headBytes = encoder.encode(lines.join('\r\n'));
  await writer.write(headBytes);
  if (response.body.length > 0) {
    const bodyBytes = encoder.encode(response.body);
    await writer.write(bodyBytes);
  }
}
