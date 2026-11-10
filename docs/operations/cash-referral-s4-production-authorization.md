# Cash referral S4 — production authorization package

**Status: PREPARED, NOT AUTHORIZED.** Nothing in this package has been run against production. Every step marked **Owner GO** needs its own explicit Owner decision. Engineering may not infer one from another, from a merge, or from this document.

- Prepared by the Cash referral executor, under the Orchestrator V7 PRODUCT FINISH GO of 2026-11-07.
- To be reviewed by Security (independently) and admitted by the Orchestrator.
- Production discovery by engineering was **repository-only**: the production host was not contacted. Section 3 lists the read-only checks an authorized operator runs on the host before the window.
- **No Claude session connects to the production host**, in discovery or in the window. The Owner, or an operator the Owner names, runs every host step; only non-secret results come back.
- Security reviewed this package on 2026-11-07 and added S-A to S-I: nginx integrity, D5, G0, G5 before the window, the release range, the flag order, secret handling, the signatures, and the negative acceptance steps.

## 1. What the Owner gets

The Owner opens the CRM and:
1. finds Иванов (by name or phone) and Сидоров (by licence);
2. records «Иванов пригласил Сидорова», which grants nobody anything;
3. separately grants Иванов perpetual Cash access;
4. checks that Иванов's Telegram Cash section now opens;
5. revokes the right, and sees the section close and the history keep both decisions.

**Out of scope:**
- automatic rewards;
- a staff directory or new employees;
- new services;
- any change to Cash money rules, limits or budgets;
- any change to Telegram bot texts.

## 2. What must be true before the window (gates)

| # | Gate | Owner of the gate | State on 2026-11-10 |
|---|---|---|---|
| G0 | **Which host is production, and in what state.** `yokoone.ru` is understood to point at the Beget host, whose status the Owner has not established. If production is that host with an unknown status, rotate **every** class C secret in `docs/SECRETS.md` before the window, not only `ADMIN_PASS`. If production was rebuilt, the new host needs a Security perimeter admission. | **Owner**, with Security | Open. |
| G1 | PR #198 (S4) merged into MAIN through Orchestrator admission. Hosted CI must be green on the exact head, and Security PASS, including the C1 delta. | Orchestrator | **Met.** The Owner merged #198 on 2026-11-08 as `3c0c6824`, right after #196. Security: PASS on `eb5b508a` (C1 and N1 closed; C2 and P1 belong to the wiring and to production), carried over to the final head `bffc0b56`, whose S4 product diff is unchanged (`af3c27b9…`). That head merged MAIN `a16489f5` (#205); its ownership amendment was regenerated mechanically after the #205 tail (amendment 47, 2,803 surfaces). The full Heavy pass ran on `eb5b508a` (26/26) and on `f7977796`. Hosted CI `42439253837` on `bffc0b56` was SUCCESS. The tree of `3c0c6824` is byte-identical to the local trial merge of `a16489f5` + #196 + #198, on which every control passed. Post-merge hosted CI: run `42498667538` on `3c0c6824` was cancelled by the workflow's concurrency when #206 merged, which is not a failure; the proof is run `42499804673` on the descendant `7bf380c2` (`3c0c6824` plus one test file), whose result the Orchestrator records. |
| G2 | PR #196 (bot wording for a merge-held confirmed link) merged. CASH PILOT requires it before referral access is activated. | Orchestrator | **Met.** The Owner merged #196 (head `104e38dc`, CI SUCCESS) on 2026-11-08 as `587a0a6a`. |
| G3 | **Staff Session v1.3** (`docs/design/staff-session-v1.md`; v1.2 approved by the Owner on 2026-11-08, v1.3 final design pass by Security), as `docs/design/cash-staff-authority-v2.md` needs it. D1: Identity Access publishes `getStaffSessionPrincipalV1()` (individual passwords, sessions, revocation). D2: Contacts admits `staff_session` and publishes the read-authority answer the referral screen asks. Each gets an independent Security review. D1 brings its own migration `20261108210000_add_staff_credential` (sha256 `37496e67680637ee2a42f6dfcea21d6ab7d064d57e065a56894de671b836c459`) and settings (`STAFF_SESSION_SECRET`, class C; `STAFF_SESSION_REVOCATION_EPOCH`; `YOKO_STAFF_SESSION_ENFORCE`; `YOKO_USER_REGISTRY_FILE`, with the one-time `YOKO_USER_REGISTRY_SEED=once`), which join the release range (G7). **Condition C-D3b (Security): the staff registry is on persistent storage, and `YOKO_USER_REGISTRY_FILE` points at it, before `STAFF_SESSION_SECRET` is issued in production.** Cash takes the employee's role from that registry as soon as one credential exists, whatever `YOKO_STAFF_SESSION_ENFORCE` says, so a registry an image redeploy can restore would undo a demotion. The integration-admin facts of contract v1 are not built. | Identity Access («YOKO CRM — Identity Access — PC_Эволюция») for D1; the Contacts owner for D2; the Owner for C-D3b and the secret | D1: **met in code.** #212 merged into MAIN on 2026-11-10 (`1aaf2e48`, MAIN `42caee7e`), Security ADMIT. Production: C-D3b, the secret and the first credential (D4, after G5) are open, each with its own Owner GO. D2: open; the decision is in the Orchestrator's inbox. |
| G4 | Cash wiring, merged: `resolveCashStaffAuthorityV1` through `resolveCashStaffAuthorityFromSessionV1` (writes only for a confirmed `Администратор`), the read guards through D2, the C2 source control (allowlist of the four write callers and the resolver, and no `authority` literal outside the binder), and negative proofs. | Cash executor | The binding is in MAIN (#211, `35569b2d`). **Writes:** the wiring PR on MAIN `42caee7e` (branch `claude/cash-staff-session-wiring-42caee7e-20261110`) resolves the writer from Identity Access's Staff Session and carries the C2 control `tools/architecture/check-cash-referral-staff-authority-boundary.mjs`, which every hosted CI run executes (13 mutants, each caught); Security review requested. **Reads:** still the integration-admin principal; the read guards through D2 are a later Cash change once D2 exists. |
| G5 | `ADMIN_PASS` is rotated (Security P1), **before the window, not only before writes.** A MAIN deploy also releases #201's person card, for which this rotation was already a production condition. Even the read-only referral screen shows personal data to anyone who holds the old `ADMIN_PASS`, and its Beget copy is compromised. After G4 it is also the key to perpetual Cash access. | **Owner action** | Open. |
| G6 | Read-only production discovery (section 3, D1–D5) has been done and its findings reviewed. | Authorized operator, with Owner GO for host access | Not done. |
| G7 | **The release range is collected.** A MAIN deploy releases everything since the production lineage, not only this PR. The Orchestrator gathers each PR's production conditions in that range. Security's known ones: #201's P1, plus its three legacy-Prisma adapters, which have no live database test and are on its production acceptance checklist; BR-4 #197's open Stage A CI-2, PostgreSQL barrier acceptance and R3-L1. Calling C3a #203 entered MAIN on 2026-11-08 (`3ac5ce07`), so its production conditions are in the range too. Security's known ones: live campaign calling stays unreachable (`AI_CALL_CAMPAIGN_RUNTIME_MODE` only `disabled` or `simulated`, no C3b activation), and any activation first needs L1 (E.164 re-checked before the ESL originate, with a hostile-number test) and L2 (a separate Security review); the Calling owner lists the rest. Contact Identity #205 (`a16489f5`) and Telegram #206 (`7bf380c2`, tests only) also entered MAIN on 2026-11-08, and their owners list their conditions. SendToContact #183 (`2c790ca0`), Messaging R-21 #208 (`d516698e`), Cash #211 (`35569b2d`), and on 2026-11-10 Identity Access #212 (`1aaf2e48`), OD-12 #213 and MAX #209 (MAIN `42caee7e`) entered MAIN too; their owners list their conditions. #212's include C-D3b and the settings of G3. Android #182 is not in MAIN. Security decided its B05 on 2026-11-08: it blocks neither MAIN nor the release and needs no mitigation, because the production template must keep G4 (the Cash realm's own user file) and G6 (Authorization stripped before Gravity), which the window checks through `verify-gate` and the P0 live check. The recommended hardening H-1 (strip Authorization on `/wss-sip` at the next sanctioned template change) is not a gate. | Orchestrator | Open. |

**Without G3–G4 the release is still safe** once G0, G5 and G7 hold, and so is a release that contains the wiring while production has no `STAFF_SESSION_SECRET`. The referral screen deploys read-only: search and the person card work for the integration administrator, and every write refuses with `staff_session_unavailable`, because Cash binds an authority only from a verified Staff Session, and without the secret Identity Access verifies none.

## 3. Read-only production discovery (to run on the host, not by engineering)

The repository's production migration authority (`architecture/migrations/v1/production-migration-authority.json`) records the production schema target as `20260809140000_add_domain_outbox`.

Twelve later migrations are SOURCE_ONLY_NOT_APPLIED in `architecture/migrations/v1/pending-source-migrations.json` on MAIN `42caee7e`. S1 and S4 are two of them; Messaging R-21's `20261108120000_add_messaging_held_channel_message` and Identity Access's `20261108210000_add_staff_credential` (G3) come after them:

| Migration | Owner | sha256 |
|---|---|---|
| `20261101120000_add_cash_referral_access` (S1) | fleet_operations | `f85c0c616ab21fb7c2fc6f9cf19809cbe7226e56c5d365a21f0b0023781db40e` |
| `20261106210000_add_cash_referral_manager_links` (S4) | fleet_operations | `5328b82be58278d38b6023b8d13a4abf76ed1acd5166b992ef3cfdbdaf74c183` |

The Cash pilot already runs in production, so the live database is likely ahead of that repository record. Only the host can say how far.

**D1 and D2.** The operator runs these in a read-only transaction, or under a read-only role, through `docker exec` into the database container or with a `.pgpass`. Never pass `DATABASE_URL` or a password in argv.

```sql
BEGIN READ ONLY;
-- D1: what Prisma has applied after the recorded target
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations"
WHERE migration_name > '20260809140000_add_domain_outbox'
ORDER BY migration_name;

-- D2: whether the S1 ledger exists, and that no manager row exists yet
SELECT to_regclass('"CashAccessEvent"') AS ledger,
       to_regclass('"CashReferralManagerInvitation"') AS manager_invitations;
SELECT "actorKind", count(*) FROM "CashAccessEvent" GROUP BY 1;   -- only if D2 shows the ledger
ROLLBACK;
```

The operator also reads, without changing:
- **D3, the Cash flags.** Read only these four keys, never the whole file:
  ```sh
  grep -E '^(YOKO_CASH_REFERRAL_ACCESS|YOKO_CASH_ACCESS_LEDGER|BOT_COMPENSATION_ENTRY_ENABLED|BOT_REFERRAL_ENTRY_ENABLED)=' .env.production
  ```
  Do not print `.env.production`, and do not paste it into a chat, an AI session or a ticket.
- **D4, the edge gate.** Run `verify-gate.sh pre` and the P0 checker's `live` from `deploy/nginx/ops/cash-gate`. Both only read.
- **D5, what a deploy would change.** In `/opt/crm`:
  - `HEAD`, the branch, and `git status --porcelain -- deploy/nginx`: does the production nginx template differ from the checkout?
  - the digest and the source commit of every running image;
  - `manager-credentials.sh paths <live template>`.

  Without D5 nobody can tell what a deploy would roll out (everything from the production lineage up to MAIN), nor whether the live template survives a `git pull`.

**Why D1 decides the window.** The gravity-mvp image runs `prisma migrate deploy` at start (`docs/operations/production-release-topology.md`). **Deploying a MAIN image is itself the migration step:** it applies every migration production has not recorded, in name order, not only S1 and S4. If D1 shows anything other than S1 and S4 still pending, the GO must name those migrations too, or the deploy must wait.

**Until the window: no production deploy of MAIN at or after the #198 merge** (nor after #194 if S1 is still pending).

**Why a plain deploy also endangers nginx.** `scripts/deploy.sh` runs `git pull --ff-only` in the checkout and then `docker compose up -d ${TARGET_SERVICES}`, and with no services named it brings up every service. nginx mounts `./nginx/templates` from that checkout and renders it with envsubst at start and on reload. The cash-gate README is explicit: MAIN's template is not a production source, and nginx is never synced from MAIN (offline harness case H3: a staff login reaches a Cash action off-path and the bot webhook). So a deploy of MAIN can switch off the Cash deny-map and the N1 webhook denials:
- at once, if the nginx container is recreated;
- later, on any reload or restart, a certificate renewal for example.

## 4. The release window (one window, in this order)

Each numbered step is **Owner GO** unless marked otherwise.

1. **Freeze.** No other deploy or nginx change during the window.
2. **Backup.** Take a database snapshot or `pg_dump` of the production database. **The dump is a class C artefact: it holds credentials and personal data.**
   - Encrypt it and restrict who can read it.
   - Keep a copy off this host; the host must never hold the only copy.
   - Never put it in the repository or in a session's scratch directory.
   - Record its sha256, check it with `pg_restore --list`, and set a date by which it is deleted.
3. **Pre-check (read-only).** Repeat D1–D5. Stop if anything changed since discovery.
   - If D3 shows `YOKO_CASH_ACCESS_LEDGER` or `YOKO_CASH_REFERRAL_ACCESS` on, turn it off before the deploy, or stop.
   - The new referral action ids are not on the Cash deny-map until step 5. With the flag off they answer `disabled`, and only that makes the interval between steps 4 and 5 safe.
4. **Migrations (S1 then S4)**, through a deploy of the admitted MAIN commit **for the application services only**. The image's `migrate deploy` applies the migrations in name order.
   - Name the services: `TARGET_SERVICES` lists the application services (gravity-mvp, and tg-bot for #196) and **never nginx**. nginx is not recreated.
   - The production nginx template is never replaced by MAIN's. What happens to `deploy/nginx/templates` in the checkout after `git pull` is decided beforehand, from D5.
   - The decision made from D5 must keep the production template as what nginx renders after the window too, including on an automatic certificate-renewal reload; after the first such reload, `verify-gate.sh post` and P0 `live` are run again.
   - **Right after the deploy**, before step 5 and before any nginx reload, run `verify-gate.sh post` and the P0 checker's `live`. Both only read. Anything other than PASS / HOLDS: stop, and roll back the code.
   - Converging MAIN's nginx template with production is a separate change, owned by Security. It is not part of this window.
   - **No manager write can fall between S1 and S4.** Both are applied by the same `migrate deploy` at the image's start, before the application serves a request. If S4 fails, the new image does not start and the code is rolled back to an image with no manager writes. Manager writes need `YOKO_CASH_ACCESS_LEDGER=on` (step 6) and G3–G5 (step 7), which come only after both rows are confirmed by D1.
   - Each migration is one transaction; a failed one rolls back its DDL. Run `prisma migrate resolve --rolled-back <name>` before any retry.
   - The same `migrate deploy` also applies the later migrations of the range (G7), among them `20261108210000_add_staff_credential`. It creates Identity Access's credential tables and no credential: until the Owner bootstraps one (D4), no Staff Session can exist.
   - Afterwards D1 must show both rows with `finished_at` set and checksums equal to the sha256 above, and `CashReferralManagerInvitation` must exist.
   - The migrations are expand-only: no data rewrite, and no destructive down migration.
   - Existing `CashAccessEvent` rows pass the widened CHECKs (Security, on #198), because nothing in MAIN writes `signed_staff_session` rows.
5. **Cash gate map.**
   - **Installing the cash-gate tooling on the host is a production admission of its own.** Export it from the admitted MAIN commit:
     ```sh
     git archive <commit> deploy/nginx/ops | tar -x -C <root-only dir>
     sha256sum -c deploy/nginx/ops/security-p0-shared/v1/SHA256SUMS
     ```
   - `regen-gate-map.sh <new gravity image> <kit-root>` builds the kit offline, so the new `/compensation/referrals` server actions are on the Cash action map.
   - `apply-gate.sh <kit>` installs it in the admitted slot (`CASH_SLOT=granted`).
   - `verify-gate.sh post` and P0 `live` must pass, and **Security signs that post-deploy perimeter evidence before step 6.**
   - Security's P0 checker runs fail-closed in every script.
6. **Flags**, only after step 5 passed and was signed.
   - Set `YOKO_CASH_ACCESS_LEDGER=on`. Cash then reads the access ledger, and the referral screens appear.
   - `YOKO_CASH_REFERRAL_ACCESS` **stays off**. Turning it on runs automatic qualification, which the Owner dropped on 2026-11-06. It would also need serialization against manager records (Security N2) and a decision of its own.
   - `BOT_REFERRAL_ENTRY_ENABLED` **stays off**; the bot texts are Owner-approved only.
   - `BOT_COMPENSATION_ENTRY_ENABLED` is unchanged.
7. **Writes.** These are live only if G3–G5 are done; otherwise the screen stays read-only and this step is skipped. With the wiring in the deployed image, writes open only in this order, each with its own Owner GO: the registry on persistent storage (C-D3b), then `STAFF_SESSION_SECRET` issued, then the first Администратор's password set on «Пользователи» (D4, after G5). Until the last of these, every write still refuses with `staff_session_unavailable`.
8. **Acceptance by the Owner** (section 5).

### Rollback

Rollback is cheapest first; every step is reversible without data loss.
- **Flag off.** Set `YOKO_CASH_ACCESS_LEDGER` off and restart gravity-mvp. Cash stops reading the ledger: grants and revocations stop having any effect, the bot falls back to the standard first-month programme, and the referral screens refuse with `disabled`. The ledger rows stay.
- **Gate map.** `rollback-gate.sh <backup>` restores the one backup `apply-gate.sh` made, and only if that backup keeps P0.
- **Code.** Roll back the image of the application services only, never nginx, and keep the additive tables (`ROLL_BACK_CODE_KEEP_ADDITIVE_TABLES` in the pending-migration registry). After the rollback, run `verify-gate.sh post` and P0 `live` again. There is no destructive schema rollback.
- **A wrong grant** is corrected in the product by a revoke (`manual_cleared`). The ledger is append-only and hash-chained, so nothing is deleted.

## 5. Owner acceptance script

Pick a real inviter and invitee, or a pair the Owner chooses for the test. **A grant gives real money access.** If the pair is only a test, revoke at step 7.

0. **Negative checks first:**
   - Signed in to the CRM without a Staff Session of a confirmed Администратор, `/compensation/referrals` shows «Войти» and no person data; a Менеджер's or Руководитель's verified session writes nothing, and the screen says «Закреплять приглашения и выдавать доступ может только администратор.».
   - An integration-admin cookie issued before the `ADMIN_PASS` rotation is refused, because the HMAC key changed.
   - Until G3–G5 are done, every write answers «Изменения пока недоступны: нужен подписанный вход сотрудника. Просмотр работает.» (`staff_session_unavailable`).
1. Pass the staff and Cash Basic-auth gates as today. Sign in to the CRM at `/login` as a confirmed Администратор, with that person's own password (Staff Session). No integration-admin sign-in is needed once G3–G4 are done.
2. Open «Компенсации» → «Реферальная программа» (`/compensation/referrals`).
3. Search the inviter by surname and first name, and again by phone typed with 8 or +7. Expect one person, with every park profile under one name, and namesakes shown apart.
4. Search the invitee by licence number. Pick both people explicitly, then press «Закрепить приглашение».
   - Expect «Приглашение закреплено. Доступ к компенсации не изменился.».
   - A second inviter for the same invitee is refused, and so is a self-invitation.
5. Open the inviter's card and press «Предоставить бессрочный доступ».
   - Pick the basis «Реферальная программа» naming this invitation, or «Другое решение менеджера».
   - «Другое решение менеджера» needs a comment of at least 10 characters.
   - Press «Предоставить». Expect «Бессрочный доступ предоставлен.». A second press writes nothing («Бессрочный доступ уже есть.»).
6. In Telegram, the inviter opens «💰 Компенсация наличных». Orders finished **after** the grant can be claimed; the invitee's section is unchanged.
7. Press «Отозвать доступ» on the inviter's card and confirm. Expect «Доступ отозван.». The Telegram section closes again for new claims. The card's history shows the grant and the revoke, each with the name of the Администратор who made it and the reason. The invitation record stays.
8. Sign out («Выйти»). The Staff Session ends on the server, for every device of that employee.

The same scenario is proved on an isolated PostgreSQL in `gravity-mvp/src/modules/fleet-operations/application/cash-referral-manager-scenario.postgres.test.ts`, through the real composition and adapters, including the Telegram access decision before and after the revoke.

## 6. What each party signs

| Party | Signs for |
|---|---|
| Security | #198, and the C1 delta; the Identity Access and Contacts changes (G3); the Cash binding, the wiring and the C2 control (G4); G0 with the Owner; the post-deploy perimeter evidence (`verify-gate.sh post` and P0 `live` after steps 4 and 5) before step 6; the gate-map kit (its P0 checker) |
| Orchestrator | Admission of #196 and #198 into MAIN (done on 2026-11-08); admission of G3 and G4; G7, the production conditions of every PR in the release range |
| Identity Access owner | Staff Session v1.3 and `getStaffSessionPrincipalV1()` (D1; #212 in MAIN) |
| Contacts owner | the `staff_session` read authority (D2) |
| **Owner** | G0 (which host, and the class C rotation if it is the Beget host); G5 `ADMIN_PASS` rotation; G6 host access for discovery; the installation of the cash-gate tooling export on the host; then each window step: freeze and backup, the application-only deploy that applies S1 then S4, the gate map, `YOKO_CASH_ACCESS_LEDGER=on`, and whether writes go live |
