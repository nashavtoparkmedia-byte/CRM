# mod_audio_fork (vendored)

The AI audio bridge (`tools/audio-bridge-day1/server.js`) streams call audio with the
FreeSWITCH API `uuid_audio_fork`. That API comes from drachtio's `mod_audio_fork`, which the
stock FreeSWITCH image does not ship.

The upstream repository was deleted from GitHub, so the module source is vendored here from the
Software Heritage archive and pinned by content. `PROVENANCE.json` records the archive
identifiers, every file's git blob id and SHA-256, the patches, and the build dependencies.

- `upstream/` — module files byte-identical to the archived commit
  `88e1465908a89bed5c95d336aa53a3899bb5abb5`. Do not edit them; change behaviour with a patch.
- `patches/` — applied in order with `patch -p1 --forward --fuzz=0 --batch`:
  - `0001` guards the `start` command: a missing sampling rate, `START` bypassing the usage
    guard, and an invalid URL or sampling rate no longer reach `start_capture`.
  - `0002` ignores `playAudio` messages without a string `audioContentType`.
  - `0003` makes the module permanent once loaded (`unload`/`reload mod_audio_fork` are refused):
    its teardown destroys libwebsockets contexts under running threads and aborts FreeSWITCH.
    Replacing the module therefore means restarting FreeSWITCH.
- `fs-sdk/` — configure-only stubs used to generate exact FreeSWITCH 1.10.12 headers without
  building FreeSWITCH.

`telephony/Dockerfile` builds the module. It verifies every vendored file, every patch and
the patched sources against SHA-256 values written in the Dockerfile itself, fetches FreeSWITCH
and libwebsockets by release tag with commit and tree identity checks, and fails the build if the
module's SHA-256 or its shared-library dependencies differ from the pinned values.

Changing any vendored byte therefore requires updating the pins in `telephony/Dockerfile` and
`PROVENANCE.json` together; `telephony/tests/test_inbound_ring_group.py` checks they agree.
