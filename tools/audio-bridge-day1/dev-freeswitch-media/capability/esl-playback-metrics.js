'use strict';

const net = require('net');

const HOST = '127.0.0.1';
const PORT = 8021;
const DEV_ONLY_PASSWORD = 'ClueCon';
const sessions = new Map();

let buffer = Buffer.alloc(0);
let authenticated = false;
let subscribed = false;
let finished = false;

function sessionMetrics(uuid) {
  if (!sessions.has(uuid)) {
    sessions.set(uuid, {
      module_injected_frames: 0,
      module_injected_bytes: 0,
      queue_completed_events: 0,
    });
  }
  return sessions.get(uuid);
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  return headers;
}

function parsePlainEvent(body) {
  const separator = body.indexOf('\n\n');
  if (separator < 0) return;

  const headers = parseHeaders(body.slice(0, separator));
  if (decodeURIComponent(headers['event-subclass'] || '') !== 'mod_audio_stream::playback') return;

  const uuid = decodeURIComponent(headers['unique-id'] || 'unknown');
  const content = body.slice(separator + 2);
  let event;
  try {
    event = JSON.parse(content);
  } catch {
    return;
  }

  const metrics = sessionMetrics(uuid);
  if (event.event === 'chunk_played') {
    metrics.module_injected_frames += 1;
    metrics.module_injected_bytes += Number(event.size || 0);
  } else if (event.event === 'queue_completed') {
    metrics.queue_completed_events += 1;
  }
}

function emitMetrics(reason) {
  const payload = {
    reason,
    sessions: Object.fromEntries([...sessions.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  process.stdout.write(`YOKO_ESL_METRICS ${JSON.stringify(payload)}\n`);
}

function publish(reason) {
  if (finished) return;
  finished = true;
  emitMetrics(reason);
}

function handleMessage(headers, body, socket) {
  const contentType = headers['content-type'];
  if (contentType === 'auth/request') {
    socket.write(`auth ${DEV_ONLY_PASSWORD}\n\n`);
    return;
  }

  if (contentType === 'command/reply' && !authenticated) {
    if (!(headers['reply-text'] || '').startsWith('+OK')) {
      throw new Error(`ESL authentication rejected: ${headers['reply-text'] || 'unknown'}`);
    }
    authenticated = true;
    socket.write('event plain CUSTOM mod_audio_stream::playback\n\n');
    return;
  }

  if (contentType === 'command/reply' && authenticated && !subscribed) {
    if (!(headers['reply-text'] || '').startsWith('+OK')) {
      throw new Error(`ESL subscription rejected: ${headers['reply-text'] || 'unknown'}`);
    }
    subscribed = true;
    process.stdout.write('YOKO_ESL_READY\n');
    return;
  }

  if (contentType === 'text/event-plain') parsePlainEvent(body.toString('utf8').replace(/\r\n/g, '\n'));
}

function parseMessages(socket) {
  while (true) {
    const marker = buffer.indexOf('\n\n');
    if (marker < 0) return;

    const headers = parseHeaders(buffer.subarray(0, marker).toString('utf8'));
    const contentLength = Number(headers['content-length'] || 0);
    const bodyStart = marker + 2;
    if (buffer.length < bodyStart + contentLength) return;

    const body = buffer.subarray(bodyStart, bodyStart + contentLength);
    buffer = buffer.subarray(bodyStart + contentLength);
    handleMessage(headers, body, socket);
  }
}

const socket = net.createConnection({ host: HOST, port: PORT });
socket.setNoDelay(true);

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  try {
    parseMessages(socket);
  } catch (error) {
    process.stderr.write(`YOKO_ESL_ERROR ${error.message}\n`);
    publish('protocol-error');
    socket.destroy();
  }
});

socket.on('error', (error) => {
  process.stderr.write(`YOKO_ESL_ERROR ${error.message}\n`);
  publish('socket-error');
});

socket.on('close', () => {
  publish('socket-close');
});

function shutdown(signal) {
  publish(signal);
  socket.end();
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGUSR1', () => emitMetrics('SIGUSR1'));
