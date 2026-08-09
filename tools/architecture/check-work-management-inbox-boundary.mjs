#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const assertCheck = (name, condition, detail) => {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const contract = read('gravity-mvp/src/contracts/work-management/v1/complete-task-command.ts')
const handler = read('gravity-mvp/src/modules/work-management/public/v1/complete-task-handler.ts')
const adapter = read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-completion-adapter.ts')
const consumer = read('gravity-mvp/src/app/inbox/actions.ts')
const manifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))

assertCheck(
    'completion contract is framework, persistence and provider neutral',
    !/(?:@\/lib|next\/|@prisma|prisma|telegram|whatsapp|max-actions|freeswitch)/i.test(contract),
    'contract contains an implementation dependency',
)
assertCheck(
    'completion handler depends only on the versioned contract',
    handler.includes("from '../../../../contracts/work-management/v1'")
        && !/(?:@\/lib|next\/|@prisma|prisma)/i.test(handler),
    'owner handler leaks an implementation dependency',
)
assertCheck(
    'ManagerTask persistence is isolated to the owner adapter',
    adapter.includes("from '@/lib/prisma'")
        && adapter.includes('prisma.managerTask.update')
        && !/prisma\.managerTask\.update\s*\(/.test(consumer),
    'foreign ManagerTask mutation remains outside the owner adapter',
)
assertCheck(
    'Messaging consumer invokes CompleteTaskCommand.v1',
    consumer.includes("from '@/contracts/work-management/v1'")
        && consumer.includes("from '@/modules/work-management/public/v1'")
        && consumer.includes('COMPLETE_TASK_COMMAND_V1')
        && consumer.includes('completeTaskV1({'),
    'Messaging inbox bypasses the Work Management public v1 surface',
)
assertCheck(
    'done and skipped outcomes pass unchanged to the owner',
    consumer.includes('outcome: resolution')
        && contract.includes("'done' | 'skipped'"),
    'resolution semantics changed',
)
assertCheck(
    'legacy resolvedBy marker remains stable',
    consumer.includes("resolvedBy: 'manager'"),
    'resolvedBy behavior changed',
)
assertCheck(
    'owner adapter preserves completion timestamp behavior',
    adapter.includes('resolvedAt: new Date()'),
    'completion timestamp is no longer generated at persistence time',
)
assertCheck(
    'revalidation still follows successful owner completion',
    consumer.indexOf('await completeTaskV1({') < consumer.indexOf("revalidatePath('/inbox')"),
    'revalidation order changed',
)
assertCheck(
    'context manifest already declares CompleteTaskCommand.v1',
    manifest.context.id === 'work_management'
        && manifest.commands.includes('CompleteTaskCommand.v1'),
    'Work Management manifest does not declare the completion command',
)
assertCheck(
    'contract identifier cannot silently change version',
    contract.includes("'work_management.CompleteTaskCommand.v1'"),
    'expected v1 semantic identifier is absent',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
