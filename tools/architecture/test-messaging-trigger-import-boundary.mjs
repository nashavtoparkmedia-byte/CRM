import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const wrapper = readFileSync(path.join(root, 'gravity-mvp/scripts/trigger_import.js'), 'utf8')
const entrypoint = readFileSync(path.join(root, 'gravity-mvp/scripts/trigger-import.ts'), 'utf8')
assert.doesNotMatch(wrapper, /PrismaClient|HistoryImportJob|\$executeRaw/)
assert.doesNotMatch(entrypoint, /PrismaClient|\$executeRaw|INSERT\s+INTO/i)
assert.match(entrypoint, /queueHistoryImportJobV1/)
assert.match(entrypoint, /QUEUE_HISTORY_IMPORT_JOB_COMMAND_V1/)
assert.match(entrypoint, /channels:\s*\['max'\]/)
assert.match(entrypoint, /mode:\s*'available_history'/)
assert.ok(entrypoint.indexOf('queueHistoryImportJobV1') < entrypoint.indexOf('launchImport(jobId'))
process.stdout.write('messaging trigger import boundary: PASS\n')
