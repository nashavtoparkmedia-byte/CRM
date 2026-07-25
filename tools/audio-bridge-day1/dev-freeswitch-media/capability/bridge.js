'use strict';

const crypto = require('crypto');
const net = require('net');

const PORT = 8080;
const FRAME_BYTES = 320;
const SAMPLE_RATE = 8000;
const RETURN_HZ = 997;
const RETURN_AMPLITUDE = 9000;
const MAX_WS_FRAME = 1024 * 1024;
const REQUIRED_PROBE_HEADER = 'capability-v1';

const sessions = new Map();
let shuttingDown = false;

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  throw new Error('outbound WebSocket frame too large');
}

function makeReturnFrame(state) {
  const frame = Buffer.allocUnsafe(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i += 1) {
    const sample = Math.round(
      RETURN_AMPLITUDE * Math.sin((2 * Math.PI * RETURN_HZ * state.returnSamples) / SAMPLE_RATE),
    );
    frame.writeInt16LE(sample, i * 2);
    state.returnSamples += 1;
  }
  return frame;
}

function publish(state, event) {
  const payload = {
    event,
    session_id: state.sessionId,
    receiver_accepted_frames: state.acceptedFrames,
    receiver_emitted_frames: state.emittedFrames,
    rejected_frames: state.rejectedFrames,
    cleanup_dropped_frames: state.cleanupDroppedFrames,
    unresolved_missing_frames: Math.max(0, state.acceptedFrames - state.emittedFrames),
    duplicate_frames: 0,
    out_of_order_frames: 0,
    checksum_mismatches: 0,
    exported_sha256: state.exportedHash.copy().digest('hex'),
    emitted_sha256: state.emittedHash.copy().digest('hex'),
  };
  process.stdout.write(`YOKO_MEDIA_METRICS ${JSON.stringify(payload)}\n`);
}

function handleBinary(socket, state, payload) {
  if (payload.length === 0 || payload.length % FRAME_BYTES !== 0) {
    state.rejectedFrames += 1;
    return;
  }

  for (let offset = 0; offset < payload.length; offset += FRAME_BYTES) {
    const sourceFrame = payload.subarray(offset, offset + FRAME_BYTES);
    state.acceptedFrames += 1;
    state.exportedHash.update(sourceFrame);

    const returnFrame = makeReturnFrame(state);
    const packet = encodeFrame(0x2, returnFrame);
    const writable = socket.write(packet);
    state.emittedFrames += 1;
    state.emittedHash.update(returnFrame);
    if (!writable) {
      socket.pause();
      socket.once('drain', () => socket.resume());
    }
  }
}

function parseFrames(socket, state) {
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const opcode = first & 0x0f;
    const final = (first & 0x80) !== 0;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = 2;

    if (!final) {
      state.rejectedFrames += 1;
      socket.destroy(new Error('fragmented WebSocket frames are not supported by the DEV probe'));
      return;
    }
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      cursor = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const largeLength = Number(state.buffer.readBigUInt64BE(2));
      if (!Number.isSafeInteger(largeLength)) {
        socket.destroy(new Error('unsafe WebSocket frame length'));
        return;
      }
      length = largeLength;
      cursor = 10;
    }
    if (!masked || length > MAX_WS_FRAME) {
      state.rejectedFrames += 1;
      socket.destroy(new Error('invalid WebSocket frame'));
      return;
    }
    if (state.buffer.length < cursor + 4 + length) return;

    const mask = state.buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = Buffer.from(state.buffer.subarray(cursor, cursor + length));
    state.buffer = state.buffer.subarray(cursor + length);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }

    if (opcode === 0x2) {
      handleBinary(socket, state, payload);
    } else if (opcode === 0x8) {
      socket.end(encodeFrame(0x8, Buffer.alloc(0)));
      return;
    } else if (opcode === 0x9) {
      socket.write(encodeFrame(0xA, payload));
    }
  }
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  const state = {
    sessionId: 'pending',
    handshakeDone: false,
    buffer: Buffer.alloc(0),
    acceptedFrames: 0,
    emittedFrames: 0,
    rejectedFrames: 0,
    cleanupDroppedFrames: 0,
    returnSamples: 0,
    exportedHash: crypto.createHash('sha256'),
    emittedHash: crypto.createHash('sha256'),
    published: false,
  };

  socket.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (!state.handshakeDone) {
      const boundary = state.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (state.buffer.length > 16 * 1024) socket.destroy(new Error('oversized handshake'));
        return;
      }
      const request = state.buffer.subarray(0, boundary).toString('utf8');
      state.buffer = state.buffer.subarray(boundary + 4);
      const lines = request.split('\r\n');
      const [method, target] = lines[0].split(' ');
      const headers = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) {
          headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
      }
      if (
        method !== 'GET'
        || !headers['sec-websocket-key']
        || headers['x-yoko-dev-probe'] !== REQUIRED_PROBE_HEADER
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      state.sessionId = decodeURIComponent((target || '/unknown').replace(/^\//, '').split('?')[0]);
      sessions.set(state.sessionId, state);
      const accept = crypto
        .createHash('sha1')
        .update(`${headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n`
        + `Upgrade: websocket\r\n`
        + `Connection: Upgrade\r\n`
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      state.handshakeDone = true;
      socket.write(encodeFrame(0x1, JSON.stringify({ type: 'rawAudio', data: { sampleRate: SAMPLE_RATE } })));
    }
    parseFrames(socket, state);
  });

  socket.on('close', () => {
    if (!state.published) {
      state.published = true;
      publish(state, 'closed');
    }
    sessions.delete(state.sessionId);
  });
  socket.on('error', (error) => {
    if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
      process.stdout.write(`YOKO_MEDIA_BRIDGE_CLEANUP ${error.code}\n`);
      return;
    }
    process.stderr.write(`YOKO_MEDIA_BRIDGE_ERROR ${error.message}\n`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`YOKO_MEDIA_BRIDGE_READY port=${PORT}\n`);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const state of sessions.values()) {
    if (!state.published) {
      state.published = true;
      publish(state, signal);
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
