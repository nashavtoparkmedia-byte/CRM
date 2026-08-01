# Personal MAX Text v1 operations runbook

This runbook describes the accepted production release of Personal MAX Text v1. It is for operators, not only developers. It contains no secrets and no user message payloads.

Canonical release source path:

`/home/codexbot/releases/personal-max-text-v1`

Future deploy, rollback and roll-forward operations must use this stable checkout. The historical Codex engineering checkout under `/home/codexbot/codex-work/` is retained only as evidence/work history and is not the canonical future deploy source.

If the stable checkout is missing or damaged, recover it before any release action:

```bash
mkdir -p /home/codexbot/releases
git clone --branch release/personal-max-text-v1 --single-branch \
  git@github.com:nashavtoparkmedia-byte/CRM.git \
  /home/codexbot/releases/personal-max-text-v1
cd /home/codexbot/releases/personal-max-text-v1
git rev-parse HEAD
git rev-parse @{u}
git ls-remote origin refs/heads/release/personal-max-text-v1
git status --short
```

Use the repository-scoped deploy key configured on the VPS; do not paste private key material into the command or incident notes.

Recovery of the source checkout must not deploy, restart containers, run migrations or send provider messages.

## 1. What Personal MAX Text v1 is

Personal MAX Text v1 is the production text transport between Gravity CRM and one confirmed Personal MAX account. It supports normal CRM text sending through a durable, account-scoped, fenced route and live inbound text capture into CRM.

The v1 promise is deliberately narrow:

- send and receive text for the confirmed account;
- preserve account ownership, route ownership, FIFO, idempotency and provider-confirmation gates;
- keep emergency default-off available;
- avoid blind retries and duplicate provider actions.

It does not include media, voice, reactions, editing, additional MAX accounts, a new UI, or DOM fallback.

## 2. Participating services

- Gravity CRM (`crm-gravity-mvp`): user-facing CRM, message projection and webhook ingestion.
- Personal MAX Gateway (`crm-max-personal-gateway`): browserless journal gateway, readiness gate, ledger/route checks and durable sender boundary.
- MAX Web Scraper (`crm-max-scraper`): the single browser/profile owner, WebSocket observer, capture producer and physical text sender.
- PostgreSQL (`crm-postgres`): durable journal, route registry, dispatch ledger, confirmation evidence and CRM messages.
- Browser profile (`crm_max_user_data` Docker volume): the authenticated MAX Web session state. Do not change ownership and do not run a second browser owner.

## 3. Normal operating state

Healthy production looks like this:

- gateway `/ready` returns HTTP 200 and `ready=true`;
- gateway reports `senderModulesInactive=false` and `providerActionsInactive=false`;
- scraper `/health` returns HTTP 200, `status=ready`, `isReady=true`;
- scraper `/status` reports `isLoggedIn=true`, `transport.wsConnected=true`, `transport.authenticated=true`;
- CRM `/messages` and `/api/messages/conversations` return HTTP 200;
- queue length is 0;
- capture spool pending count is 0;
- open reconciliation is 0;
- unresolved unknown attempts are 0;
- route conflicts and wrong-account counters are 0;
- restart counts for the three Personal MAX containers are stable at 0 after the last rollout;
- disk free is above the configured threshold;
- the accepted backup file exists and matches its SHA-256.

## 4. How to check each signal

Use the installed monitor for routine checks:

```bash
sudo /usr/local/sbin/crm-health-monitor.sh --dry-run
```

The monitor reads `/opt/crm/.env.production` and `/var/lib/crm/max-personal-text-operational.env`, but it never prints secret values.

Manual checks, if an operator needs them:

```bash
sudo docker exec crm-max-personal-gateway node -e "require('http').get('http://127.0.0.1:8080/ready',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(r.statusCode,b))})"
sudo docker exec crm-max-scraper node -e "require('http').get('http://127.0.0.1:3005/health',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(r.statusCode,b))})"
sudo docker exec crm-max-scraper node -e "require('http').get('http://127.0.0.1:3005/status',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(r.statusCode,b))})"
sudo docker exec crm-gravity-mvp node -e "require('http').get('http://127.0.0.1:3002/messages',r=>{r.resume();r.on('end',()=>console.log(r.statusCode))})"
sudo docker inspect -f '{{.Name}} restart={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} image={{.Config.Image}}' crm-gravity-mvp crm-max-personal-gateway crm-max-scraper
df -h /
```

Queue, reconciliation and duplicate-provider-action checks are already in the monitor. If doing a forensic check manually, query only counts/statuses; do not dump message text or provider payloads into incident reports.

## 5. Status meanings

- `queued`: CRM accepted an outbound command, but the durable sender has not started the physical action.
- `sending`: the sender has a fenced attempt in progress.
- `provider_confirmed`: MAX accepted the outbound action and returned exact provider evidence. This is not recipient delivery/read.
- `failed_before_provider_action`: the send path failed before any physical provider action was attempted. Retry may be safe only after reading the ledger reason.
- `retryable_failed`: a recoverable failure. Retry is allowed only when the ledger proves no provider action happened.
- `outcome_unknown`: a physical action may have happened but exact provider confirmation was not yet proven. Do not retry blindly.
- `reconciliation_required`: the system requires provider-store/ledger reconciliation before another action.
- `hard_failed`: terminal failure. Do not retry unless a new repair explicitly reclassifies it with evidence.

## 6. When not to press Retry

Do not press Retry when:

- the dispatch or attempt is `outcome_unknown`;
- reconciliation is open;
- a provider message id is already present;
- the route/account/fence is ambiguous;
- the failure occurred after `physicalActionStartedAt`;
- the UI status is stale but the durable ledger says provider-confirmed;
- the operator cannot prove whether MAX accepted the first action.

The safe first action is to enable default-off and collect privacy-safe evidence, not to send again.

## 7. Incident actions

### Lost authentication

Enable default-off first. Check scraper `/status`. If `isLoggedIn=false` or `authenticated=false` persists, the owner may need to re-authenticate MAX. Do not delete the browser profile.

### Queue greater than 0

If queue is non-zero only briefly, wait for the grace window. If it persists or grows, enable default-off and inspect ledger counts. Do not blind retry.

### Reconciliation greater than 0

Keep default-off until reconciliation is resolved. Use read-only provider-store evidence and exact provider ids; never infer from UI bubbles alone.

### Wrong route or wrong account

Enable default-off immediately. Verify route registry identities, account owner fence and active browser owner. Do not send a canary until the conflict is closed.

### Duplicate provider action

Stop sending via default-off. Preserve dispatch ledger, provider confirmation evidence and scraper durable sender state. Do not delete duplicate evidence.

### Lost message

Compare provider-store snapshot count with CRM message count using provider ids. Recovery must be exact-id and idempotent; never backfill by text only.

### Unicode corruption

Do not edit the message text manually. Preserve raw journal, sanitized payload SHA and rendered text evidence. Repair the decoder and replay idempotently.

### Stuck sender

Check gateway readiness, scraper `/health`, scraper `/status`, durable sender summary and PostgreSQL active claims. If a claim is active but no progress occurs, enable default-off before restarting anything.

### Disk filling

Only remove proven temporary material: BuildKit cache, dangling images, disposable test containers, stale locks or stale temporary files. Do not remove active images, rollback images, browser profile, accepted backups, evidence, volumes, journal, spool or provider confirmations.

## 8. Emergency default-off

Default-off is the immediate safety position. It disables physical provider actions without deleting state.

Use the default-off compose overlay from the canonical release source:

```bash
cd /home/codexbot/releases/personal-max-text-v1
sudo docker compose --project-name crm \
  --env-file /opt/crm/.env.production \
  --env-file /var/lib/crm/max-personal-text-operational.env \
  -f /opt/crm/deploy/docker-compose.production.yml \
  -f deploy/docker-compose.personal-max-final-default-off.yml \
  up -d --no-build --pull never --force-recreate --wait --wait-timeout 300 \
  gravity-mvp max-personal-gateway max-web-scraper
```

After default-off, verify gateway readiness and sender flags. No build or pull should be required.

## 9. Rollback

Rollback is reversible and image-based. Use only preserved rollback images listed in the release manifest. Do not remove or retag active/rollback images during an incident.

Before rollback:

1. Confirm backup is valid.
2. Confirm no active reconciliation is being mutated.
3. Enable default-off unless rollback itself is the default-off action.
4. Capture privacy-safe evidence.

## 10. Roll-forward

Roll-forward returns production to operational mode with the accepted images and operational overlay:

```bash
cd /home/codexbot/releases/personal-max-text-v1
sudo docker compose --project-name crm \
  --env-file /opt/crm/.env.production \
  --env-file /var/lib/crm/max-personal-text-operational.env \
  -f /opt/crm/deploy/docker-compose.production.yml \
  -f deploy/docker-compose.personal-max-final-default-off.yml \
  -f deploy/docker-compose.personal-max-text-operational.yml \
  up -d --no-build --pull never --force-recreate --wait --wait-timeout 300 \
  gravity-mvp max-personal-gateway max-web-scraper
```

Then run the normal operating-state checks from section 3.

## 11. Backup verification

The accepted backup is:

`/var/backups/personal-max-soak-reliability-final-20260801T075734Z/production-before-op180-rollout-8a9e7f79d912-20260801T143056Z.dump`

Expected SHA-256:

`58d55cd2f895bc7ffbc72c8ff9b9b1fbc59649a9df573166dd47e2dfa40a03de`

Verify:

```bash
sudo sha256sum /var/backups/personal-max-soak-reliability-final-20260801T075734Z/production-before-op180-rollout-8a9e7f79d912-20260801T143056Z.dump
sudo docker exec -i crm-postgres pg_restore --list < /var/backups/personal-max-soak-reliability-final-20260801T075734Z/production-before-op180-rollout-8a9e7f79d912-20260801T143056Z.dump >/tmp/pmax-restore-list.txt
```

For release acceptance, an isolated disposable Postgres restore already passed. Do not restore into production for a routine check.

## 12. Privacy-safe incident evidence

Allowed evidence:

- service/container name;
- safe error code;
- UTC time;
- counts and booleans;
- SHA-256 of raw/sanitized evidence;
- image tag, image id and OCI revision;
- ledger status counts;
- provider id counts without message text.

Forbidden evidence in incident reports:

- cookies;
- passwords;
- API keys;
- HMAC secrets;
- tokens;
- browser profile files;
- full unrelated phone numbers;
- user message payloads.

## 13. Forbidden operations

Do not:

- delete raw journal rows;
- delete provider confirmations;
- perform blind retry;
- change browser profile ownership;
- recreate a Contact just because a name matches;
- run mass backfill without dry-run;
- delete capture spool, durable sender state, production volumes or rollback images;
- run a second MAX browser owner;
- enable DOM fallback.

## 14. Return to operational state after repair

1. Confirm `/home/codexbot/releases/personal-max-text-v1` exists, is on `release/personal-max-text-v1`, is clean, and local/upstream/remote SHAs match.
2. Keep default-off while repairing.
3. Add regression coverage for the defect.
4. Run targeted and relevant full tests.
5. Secret-scan the diff.
6. Build immutable images with OCI revision labels.
7. Verify source-to-image binding.
8. Create or verify a fresh backup.
9. Roll forward with `--no-build --pull never` from `/home/codexbot/releases/personal-max-text-v1`.
10. Verify gateway ready, scraper health, CRM path, queue=0, reconciliation=0, unresolved unknown=0, restartCount stable and sender operational.
11. Run a bounded provider check only if the release gate explicitly allows it.
