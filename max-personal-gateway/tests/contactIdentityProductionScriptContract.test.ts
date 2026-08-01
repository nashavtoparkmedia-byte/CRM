import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(gatewayRoot, '..')
const productionScript = path.join(repositoryRoot, 'scripts/personal-max-rc3-contact-identity-production-v1.sh')
const source = readFileSync(productionScript, 'utf8')

test('RC3 contact identity runner is valid shell and stable-source bound', () => {
  execFileSync('/bin/bash', ['-n', productionScript])
  assert.match(source, /SOURCE_DIR=\/home\/codexbot\/releases\/personal-max-text-v1/u)
  assert.match(source, /EXPECTED_BRANCH=release\/personal-max-text-v1/u)
  assert.match(source, /sha256sum "\$SCRIPT_PATH"/u)
  assert.match(source, /rev-parse '@\{u\}'/u)
  assert.match(source, /ls-remote origin "refs\/heads\/\$\{EXPECTED_BRANCH\}"/u)
  assert.match(source, /status --porcelain/u)
  assert.doesNotMatch(source, /SOURCE_DIR=\/home\/codexbot\/codex-work/u)
})

test('fresh backup, restore gates and dry-run precede production contact repair', () => {
  const backup = source.indexOf('production-before-rc3-contact-identity.dump')
  const restoreList = source.indexOf('production-before-rc3-contact-identity.restore-list')
  const isolatedRestore = source.indexOf('isolated-restore-check.log')
  const dryRun = source.indexOf('data-repair-dry-run-before.private.json')
  const apply = source.indexOf('repair_sql 1')
  const mutationFlag = source.indexOf('production_mutated=true')
  assert.ok(backup > 0 && backup < restoreList && restoreList < isolatedRestore)
  assert.ok(isolatedRestore < dryRun && dryRun < apply && apply < mutationFlag)
  assert.match(source, /restore_container=personal-max-rc3-contact-restore-\$\{STAMP,,\}/u)
  assert.match(source, /isolated_restore_container=%s\\n/u)
  assert.match(source, /docker run -d --rm --network none --name "\$restore_container"/u)
  assert.match(source, /restore_ready_count=0/u)
  assert.match(source, /for _ in \{1\.\.120\}; do/u)
  assert.match(source, /isolated restore postgres did not become stable-ready/u)
  assert.match(source, /docker logs "\$restore_container" >>"\$EVIDENCE_DIR\/isolated-restore-check\.log"/u)
  assert.match(source, /pg_restore --no-owner --no-acl -U postgres -d restore_check/u)
  assert.match(source, /pg_isready -U postgres[\s\S]*isolated-restore-check\.log/u)
  assert.match(source, /isolated restore container cleanup failed/u)
  assert.match(source, /if \[\[ \$status -ne 0 && \$production_mutated == true \]\]; then[\s\S]*default_off_now/u)
})

test('data repair is exact scoped, audited and idempotent', () => {
  for (const literal of [
    '+79222155750',
    '+79126787532',
    'cmrjjp0s400esrb24ahlvlhci',
    'cmsaup40o0010ox0j8zyrwtlz',
    'cmqqnj6fu00dlrx2a3452e9we',
    'cmr5c2utp00emq52gv9104r2y',
  ]) assert.ok(source.includes(literal), `missing exact repair binding ${literal}`)

  assert.match(source, /INSERT INTO "ContactMerge"/u)
  assert.match(source, /personal_max_rc3_contact_identity_merge/u)
  assert.match(source, /to_regclass\('public\."Task"'\)/u)
  assert.match(source, /rc3_optional_task_plan/u)
  assert.match(source, /UPDATE "MaxRouteIdentityBinding" b[\s\S]*status='superseded'/u)
  assert.match(source, /INSERT INTO "MaxRouteObservation"/u)
  assert.match(source, /route_bindings_to_activate==0/u)
  assert.match(source, /provider_bindings_to_supersede==0/u)
  assert.match(source, /retry_reclassifies==0/u)
  assert.doesNotMatch(source, /\.delete(?:Many)?\s*\(/u)
})

test('controlled retry reuses the same failed bubble and forbids blind resend', () => {
  assert.match(source, /TARGET_MESSAGE_ID=msg_1785617763194/u)
  assert.match(source, /TARGET_CLIENT_MESSAGE_ID=cmid-1785617763428-mo6q1n/u)
  assert.match(source, /targetPhysicalActions/u)
  assert.match(source, /a\."physicalActionStartedAt" IS NOT NULL\) AS target_physical_actions/u)
  assert.match(source, /"clientMessageId"='\$TARGET_CLIENT_MESSAGE_ID'[\s\S]*NOT EXISTS \([\s\S]*"MaxOutboundCommand"/u)
  assert.match(source, /http:\/\/127\.0\.0\.1:3002\/api\/messages\/retry/u)
  assert.match(source, /target_bubbles=1 AND target_commands=1 AND target_physical_actions=1/u)
  assert.match(source, /newCrmBubbleCreated:false/u)
  assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:3002\/api\/messages"/u)
  assert.doesNotMatch(source, /3005\/v1\/personal-max\/send\/text/u)
})

test('production gates prove provider store, UI projection, restart and rollback/roll-forward', () => {
  assert.match(source, /\/v1\/personal-max\/history\/snapshot/u)
  assert.match(source, /profile_gate "\$A_TARGET_CONTACT"/u)
  assert.match(source, /search_gate "\$B_PHONE" "\$B_TARGET_CONTACT"/u)
  assert.match(source, /archive_redirect_gate "\$B_SOURCE_CONTACT" "\$B_TARGET_CONTACT"/u)
  assert.match(source, /attempt_hash_before_restart/u)
  assert.match(source, /attempt_hash_after_rollback/u)
  assert.match(source, /attempt_hash_after_rollforward/u)
  assert.match(source, /RC2_GRAVITY_IMAGE=crm\/gravity-mvp:personal-max-rc2-burst-e2711dc02d06/u)
  assert.match(source, /actual_operational_gate/u)
  assert.match(source, /MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED=true/u)
  assert.match(source, /PERSONAL MAX TEXT V1 RC3 CONTACT IDENTITY CONSOLIDATION USER CHECK READY/u)
})
