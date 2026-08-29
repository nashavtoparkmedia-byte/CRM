import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  authorizeMaintenanceWrite,
  authorizeMigrationOnlySite,
  validateCapabilityRegistry,
  validateMigrationWriteAuthorizationRegistry,
} from './maintenance-capability-policy.mjs'

const current = JSON.parse(readFileSync('architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json', 'utf8'))
const reviewed = JSON.parse(readFileSync('architecture/recovery/whole-project-dod/v2/ACTIVE_MAINTENANCE_CAPABILITY_REVIEW_20260813.json', 'utf8'))
assert.deepEqual(validateCapabilityRegistry(current), [])
assert.equal(current.capabilities.filter(row => row.approved).length, 0)
assert.deepEqual(validateCapabilityRegistry(reviewed), [])
assert.equal(reviewed.capabilities.length, 11)
assert.equal(reviewed.capabilities.every(row => row.approved && row.status === 'APPROVED'), true)
assert.equal(reviewed.capabilities.every(row => !row.source.path.includes('*') && row.source.site_signatures.every(signature => !signature.includes('*'))), true)
const reviewedSignatures = reviewed.capabilities.flatMap(row => row.source.site_signatures)
assert.equal(new Set(reviewedSignatures).size, reviewedSignatures.length, 'each reviewed active site belongs to exactly one capability')
const reviewedWrites = reviewed.capabilities.flatMap(row => row.source.site_signatures.flatMap(site_signature =>
  row.target.exact_names.flatMap(target => row.target.operations.map(operation => ({
    source_path: row.source.path,
    source_sha256: row.source.source_sha256,
    site_signature,
    lifecycle: row.lifecycle,
    production_reachability: row.invocation.production_reachability,
    data_owner: row.target.data_owner,
    target_kind: row.target.kind,
    target,
    operation,
  }))),
))
assert.equal(reviewedWrites.length, 13)
for (const write of reviewedWrites) {
  assert.equal(authorizeMaintenanceWrite(reviewed, write), true)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, site_signature: `${write.site_signature}-unreviewed` }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, source_sha256: 'f'.repeat(64) }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, lifecycle: 'UNRELATED' }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, production_reachability: 'CONFIRMED_UNRELATED' }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, data_owner: `${write.data_owner}-unreviewed` }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, target_kind: write.target_kind === 'MODEL' ? 'TABLE' : 'MODEL' }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, target: `${write.target}-unreviewed` }), false)
  assert.equal(authorizeMaintenanceWrite(reviewed, { ...write, operation: `${write.operation}-unreviewed` }), false)
}
const lifecycle = JSON.parse(readFileSync('architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json', 'utf8'))
const rollbackLifecycle = lifecycle.surfaces.find(row => row.path === 'gravity-mvp/scripts/rollback_knowledge_core.js')
assert.equal(rollbackLifecycle.lifecycle, 'DEAD_HISTORICAL')
assert.equal(rollbackLifecycle.production_capability, 'NONE')
const archivedBootstrapBundles = [
  'crm-7aea2823-gravity-outbox-recovery-v1',
  'crm-7aea2823-gravity-outbox-stabilization-v2',
  'crm-af9646f5-gravity-outbox-v1-ledger-reconciliation',
  'crm-af9646f5-gravity-outbox-v1',
]
const archivedBootstrapSuffixes = [
  'bundle/payload/install.sh',
  'inputs/migration.sql',
  'packaging/build-bootstrap-bundle.sh',
  'packaging/build-package.sh',
  'packaging/postinst',
  'src/crm-activation-profile.py',
  'src/yoko-privileged-runtime',
]
const expectedArchivedBootstrapPaths = archivedBootstrapBundles.flatMap(bundle => archivedBootstrapSuffixes.map(suffix =>
  `architecture/recovery/control-plane/v2/owner-bootstrap/${bundle}/${suffix}`,
)).sort()
const archivedBootstrapRows = lifecycle.surfaces.filter(row =>
  row.path.startsWith('architecture/recovery/control-plane/v2/owner-bootstrap/')
  && row.classification_artifact === 'ACTIVE_MAINTENANCE_CAPABILITY_REVIEW_20260813.json',
)
assert.deepEqual(archivedBootstrapRows.map(row => row.path).sort(), expectedArchivedBootstrapPaths, 'archived bootstrap classification must remain an exact 28-path set')
assert.equal(new Set(archivedBootstrapRows.map(row => row.path)).size, 28)
assert.equal(archivedBootstrapRows.every(row => !row.path.includes('*')), true)
assert.equal(archivedBootstrapRows.every(row => row.lifecycle === 'DEAD_HISTORICAL' && row.disposition === 'DEAD_HISTORICAL' && row.production_capability === 'NONE'), true)
assert.equal(archivedBootstrapRows.every(row => row.rationale.includes('no live current-runtime caller') && row.rationale.includes('grants no write authorization')), true)
const rollbackSource = readFileSync('gravity-mvp/scripts/rollback_knowledge_core.js', 'utf8')
assert(rollbackSource.indexOf('permanently disabled') < rollbackSource.indexOf('new PrismaClient()'), 'historical rollback guard must precede every database client')
const stateSummary = readFileSync('gravity-mvp/STATE_SUMMARY.md', 'utf8')
assert.doesNotMatch(stateSummary, /node gravity-mvp\/scripts\/rollback_knowledge_core\.js/u)

const approved = { capabilities: [{ capability_id:'mmc.v1.contacts.fixture', status:'APPROVED', approved:true, source:{path:'scripts/fix-contact.ts',source_sha256:'1'.repeat(64),site_signatures:['sig-contact-update']}, lifecycle:'RECOVERY', lifecycle_evidence_status:'REVIEWED_ACTIVE', invocation:{production_reachability:'CONFIRMED_MANUAL_OPERATOR'}, target:{kind:'MODEL',data_owner:'contacts',exact_names:['contact'],operations:['update']} }] }
assert.deepEqual(validateCapabilityRegistry(approved), [])
const intended = { source_path:'scripts/fix-contact.ts',source_sha256:'1'.repeat(64),site_signature:'sig-contact-update',lifecycle:'RECOVERY',production_reachability:'CONFIRMED_MANUAL_OPERATOR',data_owner:'contacts',target_kind:'MODEL',target:'contact',operation:'update' }
assert.equal(authorizeMaintenanceWrite(approved, intended), true)
assert.equal(authorizeMaintenanceWrite(approved, {...intended,target:'message'}), false, 'unrelated model write must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,operation:'deleteMany'}), false, 'unrelated destructive operation must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,data_owner:'messaging'}), false, 'wrong target owner must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,target_kind:'TABLE'}), false, 'wrong target kind must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,lifecycle:'CLEANUP'}), false, 'wrong lifecycle must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,production_reachability:'CONFIRMED_MANUAL_DEPLOYMENT'}), false, 'wrong reachability must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,site_signature:'new-unreviewed-site'}), false, 'unreviewed site in approved file must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,source_sha256:'2'.repeat(64)}), false, 'changed source bytes must fail')
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],source:{...approved.capabilities[0].source,path:'scripts/**',site_signatures:['*']}}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],lifecycle_evidence_status:'PENDING_ENTRYPOINT_REACHABILITY_REVIEW'}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],invocation:{production_reachability:'UNKNOWN'}}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],lifecycle:'NOT_A_REAL_LIFECYCLE'}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],invocation:{production_reachability:'NOT_A_REAL_REACHABILITY_STATE'}}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],target:{...approved.capabilities[0].target,kind:'PATH'}}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],source:{...approved.capabilities[0].source,path:''}}]}).length)
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],source:{...approved.capabilities[0].source,source_sha256:null}}]}).length)

const authoritySha256 = 'b'.repeat(64)
const migrationSourceSha256 = 'a'.repeat(64)
const migrationAuthority = {
  inventory_digest: 'c'.repeat(64),
  migrations: [{
    name: '20260813000000_exact_fixture',
    sha256: migrationSourceSha256,
    canonical_ordinal: 1,
    provenance: { repository_capture: 'gravity-mvp/prisma/migrations/20260813000000_exact_fixture/migration.sql' },
  }],
}
const migrationSite = {
  classification: 'MIGRATION_ONLY',
  site_signature: 'migration-exact-site',
  file: 'gravity-mvp/prisma/migrations/20260813000000_exact_fixture/migration.sql',
  line: 1,
  column: 1,
  method: 'sql-script',
  operations: [{ operation: 'CREATE_TABLE', table: 'ExactFixture', target_kind: 'TABLE' }],
  surface: { lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY', production_capability: 'CONTROLLED_MIGRATION' },
}
const migrationAuthorization = {
  schema: 'yoko.crm.reviewed-migration-write-site-authorizations.v1',
  version: 1,
  review: { status: 'COMPLETED_EXACT_SITE_REVIEW', reviewed_by: 'ARCHITECTURE_REMEDIATION' },
  authority: {
    path: 'architecture/migrations/v1/production-migration-authority.json',
    source_sha256: authoritySha256,
    inventory_digest: migrationAuthority.inventory_digest,
    migration_count: 1,
  },
  denominator: { non_test_migration_only_sites: 1, sorted_site_signatures_sha256: 'd'.repeat(64) },
  authorizations: [{
    capability_id: 'mmc.migration-site.v1.fixture.exact',
    site_signature: migrationSite.site_signature,
    status: 'APPROVED',
    approved: true,
    source: {
      path: migrationSite.file,
      source_sha256: migrationSourceSha256,
      line: migrationSite.line,
      column: migrationSite.column,
      method: migrationSite.method,
    },
    lifecycle: 'MIGRATION',
    invocation: { production_reachability: 'CONTROLLED_MIGRATION' },
    functional_owner: 'production_migration_authority',
    target: {
      data_owner: 'production_migration_authority',
      writes: [{ kind: 'TABLE', exact_name: 'ExactFixture', operation: 'CREATE_TABLE' }],
    },
    binding: {
      kind: 'CANONICAL_PRODUCTION_MIGRATION',
      name: '20260813000000_exact_fixture',
      canonical_ordinal: 1,
      artifact_sha256: migrationSourceSha256,
      repository_capture: migrationSite.file,
    },
  }],
}
const migrationValidationOptions = {
  productionMigrationAuthority: migrationAuthority,
  productionMigrationAuthoritySha256: authoritySha256,
  maintenanceCapabilityRegistry: approved,
}
assert.deepEqual(validateMigrationWriteAuthorizationRegistry(migrationAuthorization, migrationValidationOptions), [])
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, migrationSite, migrationSourceSha256), true)
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, surface: { ...migrationSite.surface, production_capability: 'UNKNOWN' } }, migrationSourceSha256), false, 'unknown analyzed reachability must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, surface: { ...migrationSite.surface, production_capability: undefined } }, migrationSourceSha256), false, 'missing analyzed reachability must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, surface: { ...migrationSite.surface, production_capability: 'CONFIRMED_MANUAL_DATA_MIGRATION' } }, migrationSourceSha256), false, 'mismatched analyzed reachability must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, site_signature: 'new-site' }, migrationSourceSha256), false, 'new migration site must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, file: 'wrong.sql' }, migrationSourceSha256), false, 'wrong source path must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, migrationSite, 'f'.repeat(64)), false, 'wrong source hash must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, operations: [{ ...migrationSite.operations[0], table: 'WrongModel' }] }, migrationSourceSha256), false, 'wrong migration target must fail')
assert.equal(authorizeMigrationOnlySite(migrationAuthorization, { ...migrationSite, operations: [{ ...migrationSite.operations[0], operation: 'DROP_TABLE' }] }, migrationSourceSha256), false, 'wrong migration operation must fail')
assert.ok(validateMigrationWriteAuthorizationRegistry({ ...migrationAuthorization, authorizations: [
  migrationAuthorization.authorizations[0], migrationAuthorization.authorizations[0],
] }, migrationValidationOptions).length, 'duplicate migration site must fail')
assert.ok(validateMigrationWriteAuthorizationRegistry({ ...migrationAuthorization, authorizations: [{
  ...migrationAuthorization.authorizations[0], approved: false, status: 'PENDING_EVIDENCE',
}] }, migrationValidationOptions).length, 'pending migration authorization must fail')
assert.ok(validateMigrationWriteAuthorizationRegistry({ ...migrationAuthorization, authorizations: [{
  ...migrationAuthorization.authorizations[0], invocation: { production_reachability: 'UNKNOWN' },
}] }, migrationValidationOptions).length, 'unknown migration reachability must fail')
assert.ok(validateMigrationWriteAuthorizationRegistry({ ...migrationAuthorization, authorizations: [{
  ...migrationAuthorization.authorizations[0], source: { ...migrationAuthorization.authorizations[0].source, source_sha256: 'e'.repeat(64) },
}] }, migrationValidationOptions).length, 'canonical source hash drift must fail')
process.stdout.write('maintenance capability exact-scope policy: PASS\n')
