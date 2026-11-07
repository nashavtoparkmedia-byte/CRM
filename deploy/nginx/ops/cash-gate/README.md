# Cash nginx gate tooling (release-safety R1–R5)

Operator scripts for the YOKO Cash perimeter in production nginx:
- the `/compensation` Basic-auth gate;
- the Cash Server Action deny-map (403 off-path);
- the N1 bot-webhook denials.

Since Security P0 (2026-10-25), both CRM hosts sit behind a site-wide staff Basic-auth gate. Every script here proves, before it installs or restores anything and again afterwards, that the gate still holds.

| Script | What it does | Writes production |
|---|---|---|
| `regen-gate-map.sh <image> <kit-root>` | (R4) Builds a map kit for a new Gravity build; the candidate is tested offline | no |
| `apply-gate.sh <kit>` | (R2) Installs a kit; verifies before and after | yes, admitted slot only (`CASH_SLOT=granted`) |
| `rollback-gate.sh <backup>` | (R1) Restores one `apply-gate.sh` backup, only if it keeps P0 | yes, admitted slot only |
| `verify-gate.sh pre\|post` | (R3) Read-only edge and internal-path expectations under P0 | no |
| `manager-credentials.sh issue\|revoke\|list\|paths` | (R5) Cash logins, always also staff logins; `paths` reports the user-file layout, never contents | `issue`/`revoke` in an admitted slot |

## The Security checker
- `../security-p0-shared/v1/` is Security's shared checker `p0-invariant/v1` and its approved-template list.
- The two files are one package: the checker reads the list from its own directory. They are byte-identical to the Security release (`SHA256SUMS`), and both digests are pinned in `lib.sh`.
- Every call verifies the pins on a private copy, then runs that copy under `env -i`.
- **Fail closed.** A missing file, a digest mismatch, VIOLATED (1), UNKNOWN (2) or a usage error (64) all stop the script.
- **Owner: Security.** Never edit the package or the pins here; take a new version from Security.

## Rules the scripts enforce
- A backup or candidate that fails the checker is refused before any file is touched.
  - The pre-P0 backups (quarantined in `.release-prep/…/cash-launch/nginx/QUARANTINED-PRE-P0/`) fail it.
  - `rollback-gate.sh` also refuses that directory by path.
- **One attempt, no fallback.**
  - `apply-gate.sh` may put back only its own run's backup, and only if that backup keeps P0.
  - `rollback-gate.sh` never tries a second backup.
  - No script suggests restoring an older configuration.
- A candidate template must be approved by Security's list and must differ from the live one only in Cash map entries (`map-only-diff`).
- **User files** are the ones the template names:
  - the staff file under realm `YOKO CRM`, and the Cash file under the `/compensation` realm;
  - either layout is accepted: `templates/` (production since 2026-10-25) or `templates/auth/` (MAIN).
  - So moving the credentials needs no script change. `manager-credentials.sh paths <template>` shows whether a template's files are in place, before that template is installed.
- No password or hash is printed, passed in argv or written to a report.

## MAIN's template is not a production source
MAIN's `deploy/nginx/templates/crm.conf.template` keeps P0, but it has none of these production pieces:
- the Cash action map;
- the N1 bot-webhook denials;
- the production Cash realm (`YOKO Cash`) and file layout.

A staff login on it can post a Cash action off-path and reach the bot webhook (offline harness, case H3). Never sync nginx from MAIN. Convergence is a separate, Security-owned change.

## Running in production
Run the scripts from an export of a MAIN commit, never from `.release-prep`:

```
git archive <commit> deploy/nginx/ops | tar -x -C <root-only dir>
sha256sum -c deploy/nginx/ops/security-p0-shared/v1/SHA256SUMS
```

Installing that export on the host is a production admission of its own.

## Tests
`tests/run-harness.sh <evidence-dir> [pre-P0-backup-dir …]` runs every script against an offline copy of production nginx:
- the production nginx image, `--network none`, copies of the configs;
- throwaway certificates and logins;
- a Gravity stub that echoes the `Authorization` header it receives.

The harness is offline (`CASH_GATE_TEST_ROOT` + `CASH_GATE_TEST_CONTAINER`, never `/opt/crm` or `crm-nginx`). It writes reports only.
