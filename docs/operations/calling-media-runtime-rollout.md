# Calling media runtime rollout — FreeSWITCH with mod_audio_fork

Owner runbook for the first production rollout of the FreeSWITCH image built from
`telephony/Dockerfile` (FreeSWITCH 1.10.12 + pinned, patched `mod_audio_fork`) together with the
audio bridge lifecycle fix in `tools/audio-bridge-day1`. It names variables only; never paste a
secret value into a terminal log, ticket, chat or agent session.

Nothing here has been executed against production. Each step is an Owner action.

## What changes when the new image runs

- `mod_audio_fork` loads as a **critical** module: if it cannot load, FreeSWITCH does not start,
  and that stops human telephony too (inbound ring group 101–103, manager outbound calls). This is
  intentional — a FreeSWITCH that silently lacks the module makes every AI call deaf. The module
  cannot be unloaded or reloaded at runtime; replacing it means recreating the container.
- Extensions `9999`/`9998` and the AI originate path become fully functional. With the AI-call flags
  enabled, real AI conversations with real cost start as soon as FreeSWITCH is recreated.
- The trunk password is read from `MEGAFON_SIP_PASSWORD` at container start. The image refuses to
  start (exit 64, restart loop) when it is missing, a placeholder, shorter than 8 characters, starts
  with `-` or `~`, or contains a character outside `A-Za-z0-9._~+=/@,-`.
- Configuration is copied from the image into `/etc/freeswitch` when a new container starts. The
  pinned base image declares no volumes and the production compose file mounts only recordings and
  logs, so `--force-recreate` applies the new configuration and discards edits made inside the old
  container.

## Before the window (read-only)

1. Confirm `docker diff crm-freeswitch` shows no hand edits under `/etc/freeswitch` that must be
   kept (the recreate discards them).
2. Confirm, **without printing the value**, that `MEGAFON_SIP_PASSWORD` in `.env.production` passes
   the image rules above and equals the credential currently registered with Megafon (for example,
   compare SHA-256 digests). The previous FreeSWITCH never read this variable, so a placeholder or
   stale value has never been exercised. If it does not pass, rotate to a compliant value inside the
   same window (step 9).
3. Confirm the `AI_CALL_*` flags (`AI_CALL_LIVE_MODE`, `AI_CALL_CONTROLLED_REAL_CALL_ENABLED`,
   campaign settings) are in their intended state.
4. Tag the current images for rollback, e.g. `crm/freeswitch:rollback-<date>` and
   `crm/audio-bridge:rollback-<date>`. A full `scripts/deploy.sh` rebuilds `crm/freeswitch:latest`
   and prunes dangling images, which would delete the only copy of the previous image.
5. The build needs github.com, snapshot.debian.org and Docker Hub, and BuildKit (Docker 23+). Build
   inside the window or under a distinct tag: building over `crm/freeswitch:latest` early arms the
   next unrelated `up -d` to recreate FreeSWITCH.

## In the window (no calls in progress)

6. Build and recreate only FreeSWITCH:
   `docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d --build --no-deps --force-recreate freeswitch`
   Do not use a full `scripts/deploy.sh`: it rebuilds and recreates every service, and its health
   loop does not detect a restart loop.
7. Manual gate — use only formatted commands, never plain `docker inspect crm-freeswitch`,
   `docker compose config`, `global_getvar`, `xml_locate` or `eval`, which print the password:
   - `docker inspect -f '{{.State.Status}} restarting={{.State.Restarting}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' crm-freeswitch`
     shows `running restarting=false`, a restart count that does not grow for at least two minutes,
     and `health=healthy`;
   - `fs_cli -x "module_exists mod_audio_fork"` returns `true`;
   - `fs_cli -x "sofia status gateway megafon"` shows `REGED`;
   - an inbound test call rings 101–103.
8. Recreate the bridge: `... up -d --build --no-deps --force-recreate audio-bridge`, confirm
   `[esl-events] subscribed` in its log, then place one controlled AI call. The order of steps 6 and
   8 is not strict: the new bridge on the old FreeSWITCH only logs a rejected fork; the old bridge on
   the new FreeSWITCH keeps the old deaf no-early-media behaviour.
9. Rotate the compromised trunk password (it was committed to the public repository and remains in
   git history and inside 23 sealed evidence archives under
   `architecture/recovery/control-plane/v2/owner-bootstrap/`) only after the new image is accepted: set the new value in `.env.production`, run
   `... up -d --no-build --no-deps --force-recreate freeswitch` (`restart` does not re-read the
   environment) and repeat the gate. From then on,
   rolling back to an image built before this change breaks trunk registration, because those images
   carry the old password in their configuration; delete them after acceptance.

## Rollback

Retag the saved image and recreate without building:
`docker tag crm/freeswitch:rollback-<date> crm/freeswitch:latest` then
`... up -d --no-build --no-deps --force-recreate freeswitch` (the same for `audio-bridge`). This is
only safe before step 9.

## Known limits carried by this rollout

- The CRM waits 10 s for the originate reply. A callee without early media who answers later is
  recorded as `outcome_unknown` (HTTP 504, retry forbidden) even though the call proceeds and the
  bridge runs the dialog and finalizes it.
- The image this runbook rolls out never hangs up an AI call itself, so a parked call whose session
  ended lasts until the far end hangs up. A bridge built from `tools/audio-bridge-day1` at or after
  the physical-termination change does end the channel once the bot itself closes the conversation
  (`end_call`), or when its session is closed while the channel is still up: it sends one
  `uuid_kill … NORMAL_CLEARING` after the final phrase has had time to play. A restart of the bridge
  still leaves live channels up, unchanged.
- There is still no maximum call duration on any layer — neither in the dialplan nor in the bridge —
  so a call nobody ends runs until the far end hangs up. The hard cap is a separate change, because
  its value is an Owner decision.
- `.env.production` is shared through `env_file` with seven services, and gravity-mvp can reveal
  `MEGAFON_SIP_PASSWORD` to administrators in env mode; see `docs/SECRETS.md` 2.9.
