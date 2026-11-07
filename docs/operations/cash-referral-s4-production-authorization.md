# Cash referral S4 — production authorization package

**Status: PREPARED, NOT AUTHORIZED.** Nothing in this package has been run against production. Every step marked **Owner GO** needs its own explicit Owner decision. Engineering may not infer one from another, from a merge, or from this document.

- Prepared by the Cash referral executor, under the Orchestrator V7 PRODUCT FINISH GO of 2026-11-07.
- To be reviewed by Security (independently) and admitted by the Orchestrator.
- Production discovery by engineering was **repository-only**: the production host was not contacted. Section 3 lists the read-only checks an authorized operator runs on the host before the window.

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

| # | Gate | Owner of the gate | State on 2026-11-07 |
|---|---|---|---|
| G1 | PR #198 (S4) merged into MAIN through Orchestrator admission. Hosted CI must be green on the exact head, and Security PASS, including the C1 delta. | Orchestrator | CI on `bbb3a5d7` in progress. Security: PASS WITH CONDITIONS; C1 is fixed in `b665bd09` and awaits delta confirmation. Waits for Calling #203, which has priority, then a mechanical governance regen. |
| G2 | PR #196 (bot wording for a merge-held confirmed link) merged. CASH PILOT requires it before referral access is activated. | Orchestrator | CI SUCCESS on `104e38dc`. Local re-check on current main passes (tg-bot 159/159, pilot 147/147, security 34/34). Waits for the integration slot after #203. |
| G3 | Identity Access implements `getIntegrationAdminSessionFactsV1()` and `sid` in the signed integration-admin session (contract `docs/design/cash-staff-authority-v1.md`, parts 1–2), with an independent Security review. | Identity Access owner, named by the Orchestrator or Owner | **Not started; no owner named.** Security recommends the `identity_access` owner who also decides Staff Session v1.2 (#200), so the payload format changes once. |
| G4 | Cash wiring: the 2 lines in `resolveCashStaffAuthorityV1`, the C2 source control (allowlist of the four write callers and the binder, and no `authority` literal outside the binder), and negative proofs, all merged. | Cash executor | Ready to do as soon as G3 lands. |
| G5 | `ADMIN_PASS` is rotated (Security P1). After G4 it is the key to perpetual Cash access, and the Beget copy is compromised. | **Owner action** | Open. |
| G6 | Read-only production discovery (section 3) has been done and its findings reviewed. | Authorized operator, with Owner GO for host access | Not done. |

**Without G3–G4 the release is still safe.** The referral screen deploys read-only: search and the person card work for the integration administrator, and every write refuses with `staff_session_unavailable`.

## 3. Read-only production discovery (to run on the host, not by engineering)

The repository's production migration authority (`architecture/migrations/v1/production-migration-authority.json`) records the production schema target as `20260809140000_add_domain_outbox`.

Nine later migrations are SOURCE_ONLY_NOT_APPLIED in `architecture/migrations/v1/pending-source-migrations.json`. S1 and S4 are the last two:

| Migration | Owner | sha256 |
|---|---|---|
| `20261101120000_add_cash_referral_access` (S1) | fleet_operations | `f85c0c616ab21fb7c2fc6f9cf19809cbe7226e56c5d365a21f0b0023781db40e` |
| `20261106210000_add_cash_referral_manager_links` (S4) | fleet_operations | `5328b82be58278d38b6023b8d13a4abf76ed1acd5166b992ef3cfdbdaf74c183` |

The Cash pilot already runs in production, so the live database is likely ahead of that repository record. Only the host can say how far. The operator runs these, read-only:

```sql
-- D1: what Prisma has applied after the recorded target
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations"
WHERE migration_name > '20260809140000_add_domain_outbox'
ORDER BY migration_name;

-- D2: whether the S1 ledger exists, and that no manager row exists yet
SELECT to_regclass('"CashAccessEvent"') AS ledger,
       to_regclass('"CashReferralManagerInvitation"') AS manager_invitations;
SELECT "actorKind", count(*) FROM "CashAccessEvent" GROUP BY 1;   -- only if D2 shows the ledger
```

The operator also reads, without changing:
- D3: the Cash flags in `.env.production`: `YOKO_CASH_REFERRAL_ACCESS`, `YOKO_CASH_ACCESS_LEDGER`, `BOT_COMPENSATION_ENTRY_ENABLED`, `BOT_REFERRAL_ENTRY_ENABLED`;
- D4: `verify-gate.sh pre` from `deploy/nginx/ops/cash-gate`, which checks the edge gate. It writes nothing.

**Why D1 decides the window.** The gravity-mvp image runs `prisma migrate deploy` at start (`docs/operations/production-release-topology.md`). **Deploying a MAIN image is itself the migration step:** it applies every migration production has not recorded, in name order, not only S1 and S4. If D1 shows anything other than S1 and S4 still pending, the GO must name those migrations too, or the deploy must wait.

**Until the window: no production deploy of MAIN at or after the #198 merge** (nor after #194 if S1 is still pending).

## 4. The release window (one window, in this order)

Each numbered step is **Owner GO** unless marked otherwise.

1. **Freeze.** No other deploy or nginx change during the window.
2. **Backup.** Take a database snapshot or `pg_dump` of the production database, and record where it is kept.
3. **Pre-check (read-only).** Repeat D1–D2. Stop if anything changed since discovery.
4. **Migrations (S1 then S4)**, through the normal deploy of the admitted MAIN commit, because the image's `migrate deploy` applies them in name order.
   - Each migration is one transaction; a failed one rolls back its DDL. Run `prisma migrate resolve --rolled-back <name>` before any retry.
   - Afterwards D1 must show both rows with `finished_at` set and checksums equal to the sha256 above, and `CashReferralManagerInvitation` must exist.
   - The migrations are expand-only: no data rewrite, and no destructive down migration.
   - Existing `CashAccessEvent` rows pass the widened CHECKs (Security, on #198), because nothing in MAIN writes `signed_staff_session` rows.
5. **Cash gate map.** `regen-gate-map.sh <new gravity image> <kit-root>` builds the kit offline, so the new `/compensation/referrals` server actions are on the Cash action map. Then `apply-gate.sh <kit>` installs it in the admitted slot (`CASH_SLOT=granted`), and `verify-gate.sh post` must pass. Security's P0 checker runs fail-closed in every script.
6. **Flags.**
   - Set `YOKO_CASH_ACCESS_LEDGER=on`. Cash then reads the access ledger, and the referral screens appear.
   - `YOKO_CASH_REFERRAL_ACCESS` **stays off**. Turning it on runs automatic qualification, which the Owner dropped on 2026-11-06. It would also need serialization against manager records (Security N2) and a decision of its own.
   - `BOT_REFERRAL_ENTRY_ENABLED` **stays off**; the bot texts are Owner-approved only.
   - `BOT_COMPENSATION_ENTRY_ENABLED` is unchanged.
7. **Writes.** These are live only if G3–G5 are done; otherwise the screen stays read-only and this step is skipped.
8. **Acceptance by the Owner** (section 5).

### Rollback

Rollback is cheapest first; every step is reversible without data loss.
- **Flag off.** Set `YOKO_CASH_ACCESS_LEDGER` off and restart gravity-mvp. Cash stops reading the ledger: grants and revocations stop having any effect, the bot falls back to the standard first-month programme, and the referral screens refuse with `disabled`. The ledger rows stay.
- **Gate map.** `rollback-gate.sh <backup>` restores the one backup `apply-gate.sh` made, and only if that backup keeps P0.
- **Code.** Roll back the image and keep the additive tables (`ROLL_BACK_CODE_KEEP_ADDITIVE_TABLES` in the pending-migration registry). There is no destructive schema rollback.
- **A wrong grant** is corrected in the product by a revoke (`manual_cleared`). The ledger is append-only and hash-chained, so nothing is deleted.

## 5. Owner acceptance script

Pick a real inviter and invitee, or a pair the Owner chooses for the test. **A grant gives real money access.** If the pair is only a test, revoke at step 7.

1. Pass the staff and Cash Basic-auth gates as today. Sign in to the CRM as a manager role, then sign in as the integration administrator at `/settings/integrations/access`.
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
7. Press «Отозвать доступ» on the inviter's card and confirm. Expect «Доступ отозван.». The Telegram section closes again for new claims. The card's history shows the grant and the revoke, each with «Администратор CRM» and the reason. The invitation record stays.

The same scenario is proved on an isolated PostgreSQL in `gravity-mvp/src/modules/fleet-operations/application/cash-referral-manager-scenario.postgres.test.ts`, through the real composition and adapters, including the Telegram access decision before and after the revoke.

## 6. What each party signs

| Party | Signs for |
|---|---|
| Security | #198, and the C1 delta; the Identity Access change (G3); the C2 control (G4); the gate-map kit (its P0 checker) |
| Orchestrator | Admission of #198 and #196 into MAIN, in the slot order (Calling #203 first) |
| Identity Access owner | `getIntegrationAdminSessionFactsV1` and `sid` |
| **Owner** | G5 `ADMIN_PASS` rotation; G6 host access for discovery; then each window step: freeze and backup, the deploy that applies S1 then S4, the gate map, `YOKO_CASH_ACCESS_LEDGER=on`, and whether writes go live |
