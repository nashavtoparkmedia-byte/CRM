# Shared Security checker contract: `p0-invariant` v1 (2026-10-25)

- **Owner:** Security (Security Claude [e4208f]).
- **Consumers:** Cash-owned nginx scripts, for integration by Cash Claude after the Telegram Driver UX task, in its own worktree.
- **Status:** READY: interface frozen, implemented and tested; the call sites are not integrated yet.

## 1. The invariant (what «P0 holds» means)

No request from the internet reaches Gravity (`gravity-mvp:3002`) without a Basic-auth login. Every nginx `server` block that proxies to Gravity (any `proxy_pass`/`set` naming `gravity-mvp:3002`), whatever its `server_name` or `listen`, must have:

| Id | Rule |
|---|---|
| G1 | server-level `auth_basic "YOKO CRM";` |
| G2 | server-level `auth_basic_user_file` naming an accepted staff file: `/etc/nginx/templates/yoko-crm-staff.htpasswd` (production layout 2026-10-25) or `/etc/nginx/templates/auth/yoko-crm-staff.htpasswd` (MAIN layout: the `auth/` directory, 0710 root:101, which the `edge_delivery` boundary control already demands for any user file) |
| G3 | server-level `add_header X-Yoko-Edge-Gate "crm-staff-p0-20261025" always;` |
| G4 | `auth_basic off` only in locations that never reach Gravity (today: `/wss-sip`); a location-level realm must name its own user file (e.g. the Cash gate) |
| G5 | no `satisfy any` |
| G6 | every location that proxies to Gravity strips `Authorization` (`proxy_set_header Authorization "";`) |

On top of the structure, production is identified against `approved-templates.v1.txt`:
- the template, with the Cash action-id map entries removed, must equal an approved P0 template;
- so a Cash regen that changes only map ids needs no Security step;
- any other byte change needs a Security approval (a new registry line).

Disk and live conditions:
- `conf.d/crm.conf` must be the exact entrypoint render of the template;
- `yoko-crm-staff.htpasswd`: regular file, 0640, uid 0, gid 101, ≥1 well-formed line, no duplicates, readable by the nginx worker (uid 101). The checker finds the staff and Cash files from the template's own `auth_basic_user_file` directives, so both layouts work without flags. A `WARN staff-dir-traversal` row means others may traverse the file's directory (production's `templates/` is 0755 today, so any host process with gid 101 could read the hash; the `auth/` layout, 0710 root:101, closes this);
- live anonymous probes on every Gravity `server_name` must return `401` with `WWW-Authenticate: Basic realm="YOKO CRM"` and the marker. This proves what the **running workers** serve, not just what is on disk.

## 2. Interface

```
CHK=/opt/codex-work/.release-prep/security-p0-shared/v1/p0-invariant.py
CHK_SHA256=<value from SHA256SUMS in this directory>       # pin it in the caller

p0() {   # p0 <mode> [args]; prints the report; returns the checker's exit code
  [ "$(sha256sum "$CHK" | cut -d' ' -f1)" = "$CHK_SHA256" ] || { echo "P0: checker digest mismatch"; return 2; }
  env -i PATH=/usr/bin:/bin /usr/bin/python3 -I "$CHK" "$@"
}
```

| Mode | Use | Reads |
|---|---|---|
| `template FILE` | a candidate template before install (structure + approved identity) | FILE, registry |
| `rendered FILE` | a rendered `crm.conf` before install (structure) | FILE |
| `backup DIR` | a restore source: `DIR/crm.conf.template` + `DIR/crm.conf` | DIR |
| `map-only-diff A B` | A and B differ only in Cash action-id map entries | A, B |
| `disk` | production template + render + staff htpasswd (+ Cash ⊆ staff) | `/opt/crm/deploy/nginx`, `docker inspect crm-nginx` |
| `live [--public]` | `disk` + `nginx -T` + worker read test + anonymous probes (inside crm-nginx; `--public` also via 155.212.130.14) | the above + 6 (12) anonymous HTTP requests |

**Options:**
- `--json`: one JSON object (`checker`, `mode`, `result`, `exit`, `checks[]`);
- `--strict-consistency`: a Cash login missing from the staff file becomes FAIL (default: WARN).

**Exit codes:**

| Code | Meaning | Caller action |
|---|---|---|
| `0` | HOLDS | may proceed |
| `1` | VIOLATED | stop; touch nothing further |
| `2` | UNKNOWN (cannot evaluate, internal fault, unparsable config, container down) | **treat exactly as 1** |
| `64` | usage error (a caller bug) | treat as 1 |

**Output:** `P0 <PASS|FAIL|WARN|UNKNOWN> <check> <detail>` lines, then `P0-INVARIANT RESULT=<HOLDS|VIOLATED|UNKNOWN> …`.
- No credential material is ever printed, so the output is safe to log.
- A `WARN test-override` row means `P0_NGINX_DIR`/`P0_CONTAINER` were set. Callers MUST run under `env -i` as above, so production calls never carry overrides.

**Cost:**
- `template` / `rendered` / `backup` / `map-only-diff`: < 1 s, no docker;
- `disk`: ~1 s;
- `live`: ~3–5 s;
- `--public`: +2 s.

It never writes anything.

## 3. Required call sites (R1–R5; Cash-owned changes, Security review)

| Script | Before any change | After reload | On failure |
|---|---|---|---|
| `rollback-gate.sh <B>` (R1) | `p0 backup "$B"` = 0, else refuse with no file touched | `p0 live` = 0 | report «P0 not holding», exit 1; **never** try another backup; escalate to Security |
| `apply-gate.sh` (R2) | `p0 live` = 0 (production must already be gated); `p0 template "$N/crm.conf.template.candidate"` = 0; `p0 map-only-diff "$T/crm.conf.template" "$N/crm.conf.template.candidate"` = 0; `p0 rendered "$N/crm.conf.rendered.candidate"` = 0 | `p0 live` = 0; `/login` anonymous = 401 «YOKO CRM» | restore **only** this run's `$B`, and only if `p0 backup "$B"` = 0; otherwise leave as is. Print no rollback-gate advice |
| `verify-gate.sh pre|post` (R3) | first row `p0 live` = 0 | — | any reopen = FAIL |
| `regen-gate-map.sh` (R4) | `p0 template "$T"` = 0 (live template gated + approved) | after building: `p0 template` + `p0 map-only-diff` on the candidate = 0; isolated test `/login` = 401 (put a test line in `$H/templates/yoko-crm-staff.htpasswd`) | STOP, no kit written |
| `manager-credentials.sh issue|revoke` (R5) | — | `issue`: append the **same** hash line to `yoko-crm-staff.htpasswd` (Cash ⊆ staff; `kit/staff-htpasswd.sh import-cash` does exactly this), then `p0 disk --strict-consistency` = 0. `revoke`: Cash file only, then `p0 disk` = 0 | report; no reload of an inconsistent state |
| `yoko-cash-monitor` (R12, separate production admission) | — | `p0 live` every run | ALERT on exit ≠ 0; never auto-fix |

Any **new** script that writes under `/opt/crm/deploy/nginx` must call `p0 live` before and after.

## 4. Edge expectations for Cash checks after P0 (replace the old ones)

| Request (anonymous) | Expected now |
|---|---|
| any CRM page or API, incl. `/login`, `/`, `/drivers`, `/messages` | `401`, `WWW-Authenticate: Basic realm="YOKO CRM"`, `X-Yoko-Edge-Gate: crm-staff-p0-20261025` |
| `/compensation`, `/compensation/*` | `401`, realm `YOKO Cash` (Cash's own gate, unchanged) |
| POST with a Cash `Next-Action` id on a non-Cash path | `403` from nginx (the map runs before auth) |
| `/api/webhooks/bot`, `/api/webhook/telegram` canonical forms | `404` from nginx |
| alternative forms (`;x`, upper case) | `401` «YOKO CRM» (never reaches the app) |
| `/api/webhooks/max`, `/api/webhook/max`, `/api/webhooks/avito` | `401` «YOKO CRM» at the edge; test handler behaviour (401/410/400) on the internal path `docker exec crm-tg-bot … http://gravity-mvp:3002/…` |
| `admin.yokoone.ru` (Telegram webhook), `yokopark.ru`, `/wss-sip` | unchanged |

## 5. Forbidden

- Restoring any template/render that fails `p0 backup`. Today that is **every** existing Cash backup (`backup-20261024T164502Z`, `regen-430964d05146/backup-20261025T152955Z`).
- Treating exit 2 as success.
- Weakening the gate to make a check green.
- Editing `approved-templates.v1.txt` or `p0-invariant.py` outside Security.

## 6. Evidence for this version

| Test | Result |
|---|---|
| `tests/run_static_tests.sh` | **30/30**. Positive: production template/render, map-only change, comment robustness, a good backup. Negative: the 4 real pre-P0 templates (kit baseline, both Cash backups, MAIN), 3 backup dirs, 13 single-rule mutations (G1–G6, a third ungated server, a nested `auth_basic off`, a realm without a user file, …). Malformed input: unbalanced, empty, missing, usage |
| `tests/run_live_harness.sh` | **11/11** on the production nginx image offline. Open baseline → 1; files gated but workers stale → 1 (caught by probes); gated → 0; conf.d-only edit → 1; staff file empty / 0644 / unreadable by the worker → 1; Cash login not in staff → WARN (0) / strict → 1; container stopped → 2 |
| Production, read-only (20:4xZ) | `p0-invariant.py live --public` → **HOLDS** |
