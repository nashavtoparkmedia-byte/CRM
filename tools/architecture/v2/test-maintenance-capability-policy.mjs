import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { authorizeMaintenanceWrite, validateCapabilityRegistry } from './maintenance-capability-policy.mjs'

const current = JSON.parse(readFileSync('architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json', 'utf8'))
assert.deepEqual(validateCapabilityRegistry(current), [])
assert.equal(current.capabilities.filter(row => row.approved).length, 0)

const approved = { capabilities: [{ capability_id:'mmc.v1.contacts.fixture', status:'APPROVED', approved:true, source:{path:'scripts/fix-contact.ts',site_signatures:['sig-contact-update']}, target:{data_owner:'contacts',exact_names:['contact'],operations:['update']} }] }
assert.deepEqual(validateCapabilityRegistry(approved), [])
const intended = { source_path:'scripts/fix-contact.ts',site_signature:'sig-contact-update',data_owner:'contacts',target:'contact',operation:'update' }
assert.equal(authorizeMaintenanceWrite(approved, intended), true)
assert.equal(authorizeMaintenanceWrite(approved, {...intended,target:'message'}), false, 'unrelated model write must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,operation:'deleteMany'}), false, 'unrelated destructive operation must fail')
assert.equal(authorizeMaintenanceWrite(approved, {...intended,site_signature:'new-unreviewed-site'}), false, 'unreviewed site in approved file must fail')
assert.ok(validateCapabilityRegistry({capabilities:[{...approved.capabilities[0],source:{path:'scripts/**',site_signatures:['*']}}]}).length)
process.stdout.write('maintenance capability exact-scope policy: PASS\n')
