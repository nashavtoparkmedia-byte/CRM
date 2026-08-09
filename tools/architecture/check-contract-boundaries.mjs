#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []

function source(relative) {
    return fs.readFileSync(path.join(root, relative), 'utf8')
}

function assertCheck(name, condition, detail) {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const contractRoot = path.join(root, 'gravity-mvp/src/contracts')
const contractFiles = []
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(candidate)
        else if (/\.ts$/.test(entry.name)) contractFiles.push(candidate)
    }
}
walk(contractRoot)

const forbiddenContractImports = [
    /from\s+['"]@\/lib\//,
    /from\s+['"]@prisma\//,
    /from\s+['"].*\/app\//,
    /from\s+['"].*\/providers?\//,
]

for (const file of contractFiles) {
    const body = fs.readFileSync(file, 'utf8')
    assertCheck(
        `provider-neutral contract: ${path.relative(root, file)}`,
        forbiddenContractImports.every((pattern) => !pattern.test(body)),
        'contract imports a persistence, framework, application, or provider implementation',
    )
}

const consumerFiles = [
    'gravity-mvp/src/app/api/ai-calls/mock/route.ts',
    'gravity-mvp/src/app/api/ai-calls/sessions/[id]/finalize/route.ts',
]

for (const file of consumerFiles) {
    const body = source(file)
    assertCheck(
        `representative consumer uses CreateTaskCommand.v1: ${file}`,
        body.includes('CREATE_TASK_COMMAND_V1') && body.includes('createTaskV1({'),
        'versioned command invocation is absent',
    )
    assertCheck(
        `foreign Task write removed: ${file}`,
        !/prisma\.task\.create\s*\(/.test(body),
        'direct foreign Prisma Task create remains',
    )
}

const handler = source('gravity-mvp/src/modules/work-management/public/v1/create-task-handler.ts')
assertCheck(
    'owner handler depends on a persistence port',
    handler.includes('CreateTaskPersistencePortV1') && !handler.includes("@/lib/prisma"),
    'handler is coupled to the legacy persistence implementation',
)

const adapter = source('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-adapter.ts')
assertCheck(
    'legacy Prisma dependency is isolated in owner compatibility adapter',
    adapter.includes("@/lib/prisma") && adapter.includes('prisma.task.create'),
    'owner compatibility adapter does not contain the legacy persistence boundary',
)

const srcRoot = path.join(root, 'gravity-mvp/src')
const internalImportViolations = []
function scanInternalImports(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) scanInternalImports(candidate)
        else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
            const body = fs.readFileSync(candidate, 'utf8')
            if (/from\s+['"]@\/modules\/[^'"]+\/internal(?:\/|['"])/.test(body)) {
                internalImportViolations.push(path.relative(root, candidate))
            }
        }
    }
}
scanInternalImports(srcRoot)
assertCheck(
    'cross-context internal module imports are forbidden',
    internalImportViolations.length === 0,
    internalImportViolations.join(', '),
)

const result = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
    contract_files: contractFiles.map((file) => path.relative(root, file)).sort(),
    representative_consumers: consumerFiles,
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (failures.length > 0) process.exit(1)
