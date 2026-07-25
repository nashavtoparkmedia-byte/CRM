# DEV-only real-time Audio Bridge loopback

This directory contains an isolated localhost proof for the Audio Bridge
transport. It is not imported by the production bridge and does not load
`.env`, CRM, Redis, FreeSWITCH/ESL, SIP, STT, TTS, LLM, or provider modules.

## Runtime boundary

- separate Node child process;
- bind address fixed to `127.0.0.1`;
- operating system selects an ephemeral port;
- ephemeral 32-byte bearer generated inside the child and transferred only
  through the private parent/child IPC channel;
- per-session reconnect key generated in memory;
- bounded total runtime and total session count, in addition to per-session
  frame, byte, queue, idle, and runtime limits;
- child V8 old-space capped at 64 MiB and a 128 MiB RSS watchdog enforced;
- no token in argv, environment files, logs, Git, or the final report;
- no PCM/WAV files are written;
- runtime directory is an exact `mkdtemp` child of
  `/var/tmp/yoko-ai-calls-audio-loopback/` and is removed after the run.

## Audio and framing

- PCM signed 16-bit little-endian (`pcm_s16le`);
- 8,000 Hz;
- mono;
- 2 bytes per sample;
- 20 ms / 160 samples / 320 PCM bytes per frame;
- one WebSocket binary message per frame;
- 28-byte `YALB` v1 envelope:
  `magic`, `version`, `type`, `flags`, `sequence`, `payloadLength`, `crc32`,
  `sentAtMs`.

The bridge decodes and validates every frame, queues the decoded PCM in a
bounded per-session queue, and constructs a new outbound envelope. It does
not blindly return the original WebSocket message.

Duplicate frames are detected by sequence and not replayed. Out-of-order
frames expose a bounded unresolved-gap count and can be retried after the
missing sequence. Accepted queued frames resume draining after reconnect.
Queue overflow uses a controlled session failure. Concurrent sessions,
completed session snapshots, frames, bytes, queues, and total runtime all
have configured bounds.

## Evidence suite

`harness.js` starts the real child process and real WebSocket clients and
executes:

- A — paced normal bidirectional streaming;
- B — controlled client disconnect;
- C — reconnect with exact sequence continuity;
- D — idle timeout;
- E — bounded backpressure failure;
- F — malformed frame rejection;
- G — duplicate rejection;
- H — out-of-order rejection and retry;
- I — session-scoped emergency stop;
- J — parallel session isolation.

It also verifies authentication failure, active-session conflict, reconnect
key isolation, accepted queued-frame continuity, client-observed end-to-end
loopback latency, child exit, PID disappearance, port release, empty runtime
directory, and zero active sessions. Failure cleanup escalates only against
the harness-owned child process (IPC shutdown, then bounded TERM/KILL).

Run from `tools/audio-bridge-day1`:

```text
/home/codexbot/.local/node-v22.18.0-linux-x64/bin/node scripts/dev-loopback/harness.js
```

Run the repeatable integration test:

```text
/home/codexbot/.local/node-v22.18.0-linux-x64/bin/node --test \
  __tests__/dev-loopback-protocol.test.js \
  __tests__/dev-loopback-integration.test.js
```

The reported latency is localhost DEV transport latency. It is not a claim
about SIP, PSTN, provider, STT, TTS, or production call latency.
