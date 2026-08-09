#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/fleet-operations/v1/update-scoring-thresholds-command.ts')
const handler = read('gravity-mvp/src/modules/fleet-operations/public/v1/update-scoring-thresholds-handler.ts')
const adapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-scoring-threshold-adapter.ts')
const consumer = read('gravity-mvp/src/app/settings/scoring/actions.ts')
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/scoring-thresholds-v1/module-manifest-amendments.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib)/i.test(contract), 'implementation leaked into contract')
check('handler is provider neutral', !/(prisma|next\/|@\/lib)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Fleet adapter', adapter.includes('prisma.scoringThreshold.upsert') && !/prisma\.scoringThreshold\.upsert/.test(consumer), 'foreign write remains')
check('adapter preserves sequential upsert', adapter.includes('for (const [key, value] of entries)') && adapter.includes('await prisma.scoringThreshold.upsert'), 'upsert sequencing drifted')
check('Configuration invokes public v1', consumer.includes('UPDATE_SCORING_THRESHOLDS_COMMAND_V1') && consumer.includes('updateScoringThresholdsV1({'), 'public command absent')
check('read behavior remains in Configuration', consumer.includes('prisma.scoringThreshold.findMany()'), 'read behavior moved outside slice')
check('revalidation paths retained', consumer.indexOf("revalidatePath('/settings/scoring')") > consumer.indexOf('await updateScoringThresholdsV1') && consumer.includes("revalidatePath('/drivers')"), 'revalidation behavior drifted')
check('exact command amendment', amendment.amendments.some((item) => item.context === 'fleet_operations' && item.add_commands?.includes('UpdateScoringThresholdsCommand.v1')), 'command amendment drifted')
check('exact dependency amendment', amendment.amendments.some((item) => item.context === 'configuration' && item.add_allowed_dependencies?.some((dependency) => dependency.context === 'fleet_operations' && dependency.surface === 'fleet_operations.public')), 'dependency amendment drifted')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
