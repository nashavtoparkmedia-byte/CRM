#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const sha256 = (relative) => createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')
const assertCheck = (name, condition, detail) => {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const contract = read('gravity-mvp/src/contracts/work-management/v1/assign-task-command.ts')
const handler = read('gravity-mvp/src/modules/work-management/public/v1/assign-task-handler.ts')
const adapter = read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-assignment-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/tasks/reassign/route.ts')
const batchHandler = read('gravity-mvp/src/modules/work-management/public/v1/reassign-tasks-handler.ts')
const manifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))

assertCheck(
    'assignment contract is framework, persistence and provider neutral',
    !/(?:@\/lib|next\/|@prisma|prisma|telegram|whatsapp|max-actions|freeswitch)/i.test(contract),
    'contract contains an implementation dependency',
)
assertCheck(
    'assignment handler depends only on the versioned contract',
    handler.includes("from '../../../../contracts/work-management/v1'")
        && !/(?:@\/lib|next\/|@prisma|prisma)/i.test(handler),
    'owner handler leaks a legacy implementation dependency',
)
assertCheck(
    'legacy persistence and event service are isolated to the owner adapter',
    adapter.includes("from '@/lib/prisma'")
        && adapter.includes("from '@/lib/tasks/task-event-service'")
        && !consumer.includes("from '@/lib/tasks/task-event-service'"),
    'owner persistence or event boundary is not isolated',
)
assertCheck(
    'representative consumer invokes the public versioned command',
    consumer.includes("from '@/contracts/work-management/v1'")
        && consumer.includes("from '@/modules/work-management/public/v1'")
        && consumer.includes('REASSIGN_TASKS_COMMAND_V1')
        && consumer.includes('taskReassignmentV1.reassignTasks({'),
    'reassignment route does not use the Work Management public v1 surface',
)
assertCheck(
    'foreign Task mutation is removed from the representative consumer',
    !/prisma\.task\.(?:create|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(consumer),
    'reassignment route retains a direct Task mutation',
)
assertCheck(
    'owner adapter preserves lookup before mutation',
    adapter.indexOf('prisma.task.findUnique') < adapter.indexOf('prisma.task.update'),
    'legacy lookup/update order changed',
)
assertCheck(
    'owner adapter preserves update before event append',
    adapter.indexOf('prisma.task.update') < adapter.indexOf("logTaskEvent(taskId, 'reassigned'"),
    'legacy update/event order changed',
)
assertCheck(
    'not-found and already-assigned tasks remain no-ops',
    adapter.includes("if (!task) return 'not_found'")
        && adapter.includes("if (task.assigneeId === assigneeId) return 'unchanged'"),
    'legacy skip semantics changed',
)
assertCheck(
    'reassignment event payload remains stable',
    adapter.includes('from: oldAssigneeId')
        && adapter.includes('to: assigneeId')
        && adapter.includes('toName: assigneeName'),
    'reassignment audit payload changed',
)
assertCheck(
    'consumer increments only completed reassignments',
    batchHandler.includes("if (status === 'reassigned') reassigned++"),
    'batch handler result-count semantics changed',
)
assertCheck(
    'context manifest already declares AssignTaskCommand.v1',
    manifest.context.id === 'work_management'
        && manifest.commands.includes('AssignTaskCommand.v1'),
    'Work Management owner manifest does not declare the command',
)
assertCheck(
    'legacy task event service is byte-identical',
    sha256('gravity-mvp/src/lib/tasks/task-event-service.ts')
        === '938dbdd85c2259b32d0999bc952fa9da36c2a4aec54693a2d1b1ff7ec83e6738',
    'protected task event implementation changed',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
