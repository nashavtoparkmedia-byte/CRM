# CRM Telephony — FreeSWITCH + Megafon SIP trunk

Self-hosted SIP stack for the CRM. Connects to Megafon's "MultiFon Business"
trunk and exposes Event Socket Layer (ESL) for `gravity-mvp` to receive
call events and originate calls.

## What's in (Stages 1–3)

- **Stage 1** — FreeSWITCH registered to Megafon, outbound calls work
- **Stage 2** — Prisma `Call` model, ESL listener writing call lifecycle to DB,
  React WebRTC softphone in CRM browser, incoming call popup, click-to-call
  from driver / contact cards, calls history list, internal extensions (101–103),
  forking dialplan (rings every registered manager simultaneously)
- **Stage 3** — Stereo call recording (WAV → MP3, libmp3lame 64kbps),
  MinIO object storage as part of this compose, audio player in calls list
  with presigned URLs (1h TTL)

Coming next:

- **Stage 4** — Whisper transcription + Claude AI dialog analysis
- **Stage 5** — Stats dashboard per manager / lead

## Requirements

- Docker Desktop (Windows) or Docker Engine (Linux)
- Megafon "MultiFon Business" account with active SIP credentials
- Network: outbound UDP/5060 to `sbc.megafon.ru` must be open

## Setup

```powershell
cd telephony
cp .env.example .env
# Open .env in editor and fill in MEGAFON_SIP_USERNAME / MEGAFON_SIP_PASSWORD
docker compose up -d
```

## Verify trunk registration

After ~10 seconds, check that the gateway registered successfully:

```powershell
docker exec -it crm-freeswitch fs_cli -x "sofia status gateway megafon"
```

Expected output includes `State: REGED` (registered). If it says `FAIL_WAIT`
or `TRYING`, check the password and that your network can reach
`sbc.megafon.ru:5060/udp`.

## Test outbound call

From inside `fs_cli`, originate a call to a test number (your own mobile):

```powershell
docker exec -it crm-freeswitch fs_cli
> originate sofia/gateway/megafon/79001234567 &echo
```

You should hear your own audio echoed back. If the call fails, watch logs:

```powershell
docker logs -f crm-freeswitch
```

## Architecture

```
┌─ telephony/ (this folder) ─────────────────────────────────────┐
│                                                                 │
│  FreeSWITCH (Docker)                                            │
│  ├── sip_profiles/external/megafon.xml  — trunk to Megafon      │
│  ├── dialplan/default/01_megafon_outbound.xml  — outbound route │
│  ├── autoload_configs/event_socket.conf.xml  — ESL on :8021     │
│  └── vars.xml  — substitutes env credentials                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
         │ SIP/UDP 5060
         ▼
   sbc.megafon.ru  (Megafon MultiFon Business)
```

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 5060 | UDP/TCP | SIP signaling — internal profile (Linphone, IP phones) |
| 5080 | UDP | SIP signaling — external profile (inbound from Megafon SBC) |
| 7080 | TCP | WebSocket — browser WebRTC softphones (sip.js / JsSIP) |
| 16384–16484 | UDP | RTP media (100 concurrent calls) |
| 8021 | TCP | Event Socket (ESL) — bound to 127.0.0.1, used by gravity-mvp |
| 9000 | TCP | MinIO S3 API — bound to 127.0.0.1, used by gravity-mvp |
| 9001 | TCP | MinIO web console — bound to 127.0.0.1, open http://localhost:9001 |

## Recordings & storage

FreeSWITCH writes raw stereo WAV files to `telephony/recordings/` (bind-mounted
into the container). On `CHANNEL_HANGUP_COMPLETE`, gravity-mvp's ESL handler
converts the WAV to MP3 (libmp3lame, 64kbps stereo) via fluent-ffmpeg, uploads
to MinIO under `recordings/YYYY/MM/<fsUuid>.mp3`, and stores the object key
on `Call.recordingPath`. WAV is deleted after successful upload.

To listen to a recording in the UI, click the play button next to the call in
the calls list. The browser fetches a 1-hour presigned URL from
`/api/calls/[id]/recording` and streams the MP3 directly from MinIO.

**For prod on Linux VPS:** swap MinIO for Yandex Object Storage — same code,
just change `S3_*` env vars in `gravity-mvp/.env`:
```
S3_ENDPOINT=https://storage.yandexcloud.net
S3_ACCESS_KEY=<your YC key id>
S3_SECRET_KEY=<your YC secret>
S3_BUCKET=<your bucket name>
```

## Manager extensions

Each manager gets one extension (101, 102, ...) defined in
`conf/directory/default/NNN.xml`. They use the same credentials in both:

- **CRM browser softphone** — auto-registered when they log into Yoko CRM
- **Linphone on their phone** — manual setup, see [LINPHONE_SETUP.md](./LINPHONE_SETUP.md)

Forking is configured in `conf/dialplan/default/02_megafon_inbound.xml`:
every incoming call rings every live registration for extensions 101–103
simultaneously. Several computers/browser profiles may register the same
extension; the first device to answer takes the call and every other leg is
cancelled automatically.

## Known limitations on Windows + Docker Desktop

- **Outbound calls work** — your container can reach Megafon's SBC.
- **Inbound calls do NOT work** on a typical residential/office connection
  behind carrier NAT — Megafon's SBC cannot reach your machine. This is
  expected for Stage 1.
- For inbound calls in production: deploy this stack to a Linux VPS with
  a public IP, set up DNS + Let's Encrypt, and the same compose file works
  without changes (the WebRTC profile added in Stage 2 will use that TLS cert).

## Security notes

- `.env` is gitignored — SIP credentials never leave the host
- `ESL_PASSWORD` defaults to `ClueCon` for local dev; **change it on any
  production deployment** and add it to the host's environment
- ESL port 8021 is mapped only to `localhost` (via docker-compose default
  bind) — not exposed to the network
