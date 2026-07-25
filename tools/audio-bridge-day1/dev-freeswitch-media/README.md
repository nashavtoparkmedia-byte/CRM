# YOKO DEV FreeSWITCH media image

This directory is an isolated, reproducible DEV-only recipe for FreeSWITCH
1.10.12 with bidirectional `mod_audio_stream`.

It is not a production image. It must not be deployed, pushed to an external
registry, connected to SIP/PSTN gateways, or used with paid speech/AI
providers.

## License boundary

The selected module is
[`AlchemillaHQ/mod-audio-stream`](https://github.com/AlchemillaHQ/mod-audio-stream)
at exact commit `a25fb1fe530ec6a612d321ff04f70be69b1a257c`.
It is licensed under AGPL-3.0-only or a separate proprietary license.

This recipe is approved only for isolated internal DEV capability testing.
Production use or external distribution requires a separate legal/license
decision. The complete AGPL text and the exact source location are included.

## Pinned inputs

- Runtime:
  `safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6`
- FreeSWITCH revision:
  `a88d069d6ffb74df797bcaf001f7e63181c07a09`
- FreeSWITCH source SHA-256:
  `ca4932f5d5fb76040901df1eaba3c2d5fb71a500d81549c70f78a8f47c410094`
- Builder:
  `debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e`
- Debian snapshot:
  `20260713T000000Z`
- Module commit:
  `a25fb1fe530ec6a612d321ff04f70be69b1a257c`
- Module source SHA-256:
  `32aa5649c92b6795659cbbc2f53cd3a2d90337e807ce45c366ca7c81a0cf6f46`
- BuildKit SBOM generator:
  `docker.io/docker/buildkit-syft-scanner@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68`
- Capability sidecar:
  `node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0`

`provenance.json`, `checksums.sha256`, the checked-in SPDX attestation,
and the image OCI labels carry the same identities.

The upstream image's generic `vanilla` sample configuration is removed from
the final image. The image entrypoint defaults directly to the isolated
`yoko-media-dev` configuration and temporary runtime paths. Capability tests
still pass the same arguments explicitly and never mount production config.

## Build

Requirements:

- Linux/amd64 Docker host with Buildx;
- `curl`, `git`, `python3`, and GNU core utilities;
- at least 12 GiB free before the build and 8 GiB after cleanup;
- no parallel image build.

Run:

```bash
sudo ./build-dev-image.sh
```

The script:

1. downloads only the exact FreeSWITCH commit;
2. fetches only the exact module commit and creates a deterministic Git archive;
3. checks both source SHA-256 values;
4. creates a narrow temporary build context;
5. builds with at most two compiler jobs;
6. creates an OCI artifact with SPDX SBOM and SLSA provenance;
7. loads only the exact DEV tag;
8. removes the temporary context and OCI archive.

To retain regenerated attestations:

```bash
sudo YOKO_ATTESTATION_DIR=/var/tmp/yoko-fs-media-attestations ./build-dev-image.sh
```

No image is pushed.

## Capability proof

Ensure the pinned Node sidecar image and the freshly built DEV image are
already present locally, then run:

```bash
sudo python3 capability/run-capability.py
```

The test refuses to reuse existing containers or networks. It creates an
internal Docker network with no published ports and starts:

- one read-only FreeSWITCH container from the immutable built image;
- one read-only deterministic PCM WebSocket bridge;
- one read-only ESL metrics sidecar sharing only the DEV FreeSWITCH network
  namespace.

The full-duplex probe sends a 440 Hz source tone into the B-leg. The bridge
returns deterministic 997 Hz PCM S16LE at 8 kHz. A stereo FreeSWITCH recording
must contain 440 Hz only on the read side and 997 Hz only on the write side.
`module_injected_frames` is counted only from
`mod_audio_stream::playback/chunk_played`, emitted after the module copies PCM
into a FreeSWITCH write-replace frame.

The isolation probe starts two UUID-scoped sessions. It stops the first stream
while both channels remain active and proves:

- the first injected-frame counter stops;
- the second counter continues growing;
- pause/resume/stop on the second UUID still works;
- each WebSocket session closes exactly once;
- no reconnect occurs;
- all known channels close.

Recordings and all capability containers/networks are removed in `finally`,
including after a failed assertion.

## Module contract used by the probe

- Module path: `/usr/lib/freeswitch/mod/mod_audio_stream.so`
- API/application: `uuid_audio_stream`
- Start:
  `uuid_audio_stream <uuid> start ws://<host>:<port>/<uuid> mono 8k`
- Stop: `uuid_audio_stream <uuid> stop`
- Transport: RFC 6455 WebSocket
- Export: mono PCM S16LE, 8 kHz, 20 ms frames in this probe
- Return metadata:
  `{"type":"rawAudio","data":{"sampleRate":8000}}`
- Return frames: unmasked server binary PCM, 320 bytes per 20 ms
- Required variable: `STREAM_PLAYBACK=true`
- Probe variables:
  `STREAM_SAMPLE_RATE=8000`, `STREAM_BUFFER_SIZE=20`,
  `RECORD_STEREO=true`

The B-leg must have an outbound media clock. The DEV dialplan uses a local
200 Hz generator solely to create write frames; the injected 997 Hz return
replaces that write media.

## Known limits

- The module license is not approved for production use.
- The playback buffer is bounded to 30 seconds. A complete incoming chunk is
  rejected when insufficient buffer space remains.
- The module WebSocket outbound queue is bounded to 1024 frames; maximum frame
  size is 1 MiB.
- One tail return frame can remain unconsumed during normal channel teardown;
  the capability report records this explicitly as a cleanup drop.
- The selected source describes raw audio as L16, while the pinned linux/amd64
  implementation copies native little-endian samples directly; this probe
  therefore uses PCM S16LE.
- The image contains a loopback-only DEV event-socket credential. It is not a
  production secret and no port is published.
- The upstream `vanilla` sample configuration is absent; only the narrow
  `yoko-media-dev` configuration is present under the FreeSWITCH config root.

## Focused checks

```bash
python3 tests/verify_provenance.py
python3 -m py_compile capability/*.py tests/*.py
node --check capability/bridge.js
node --check capability/esl-playback-metrics.js
```
