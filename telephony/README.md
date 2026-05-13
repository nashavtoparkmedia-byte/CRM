# CRM Telephony — FreeSWITCH + Megafon SIP trunk

Self-hosted SIP stack for the CRM. Connects to Megafon's "MultiFon Business"
trunk and exposes Event Socket Layer (ESL) for `gravity-mvp` to receive
call events and originate calls.

## Stage 1 scope

This stage gets the trunk registered and outbound calls working. Coming next:

- **Stage 2** — Prisma `Call` model, WebRTC softphone in React, click-to-call, incoming-call popup
- **Stage 3** — Call recording (WAV → MP3 → MinIO), audio player in lead/driver card
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
| 5060 | UDP/TCP | SIP signaling |
| 16384–16484 | UDP | RTP media (100 concurrent calls) |
| 8021 | TCP | Event Socket (ESL) — internal use by gravity-mvp |

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
