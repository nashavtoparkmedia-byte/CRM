#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/ai-knowledge/v1/record-knowledge-usage-command.ts')
const handler = read('gravity-mvp/src/modules/ai-knowledge/public/v1/record-knowledge-usage-handler.ts')
const adapter = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-record-knowledge-usage-adapter.ts')
const consumer = read('gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/PipelineWorker.ts')
const messaging = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
const amendment = JSON.parse(read('architecture/isolation/ai-knowledge/usage-log-v1/module-manifest-amendments.json'))

check('contract is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('usage write is static and isolated in AI Knowledge adapter', (adapter.match(/prisma\.\$executeRawUnsafe\(/g) || []).length === 1 && !/prisma\.\$executeRaw\s*`/.test(adapter) && adapter.includes('INSERT INTO "AiKnowledgeUsageLog"') && !consumer.includes('INSERT INTO "AiKnowledgeUsageLog"'), 'foreign or dynamic write remains')
check('runtime context remains chat_reply', adapter.includes(`\\'chat_reply\\'::"AiKnowledgeRuntime"`), 'runtime context drifted')
check('database timestamp semantics retained', adapter.includes('NOW()'), 'usedAt timestamp drifted')
check('all legacy persistence columns retained', [
    'id', '"itemId"', '"runtimeContext"', '"decisionLogId"', '"messageId"',
    '"retrievalScore"', '"rerankScore"', '"usedInReply"', '"policyDecision"',
    '"shadowMode"', '"escalationReason"', '"usedAt"',
].every((field) => adapter.includes(field)), 'column mapping drifted')
check('policy classification stays in caller', consumer.includes("policyDecision = 'used'") && consumer.includes("policyDecision = 'filtered_'"), 'policy semantics moved or drifted')
check('used-in-reply rule stays in caller', consumer.includes('const usedInReply  = usedInPrompt && actualReplySent'), 'used-in-reply semantics drifted')
check('one command remains inside candidate loop', consumer.indexOf('for (const cand of kr.trace.candidates)') < consumer.indexOf('await recordKnowledgeUsageV1({'), 'candidate ordering drifted')
check('per-item tolerance retained', /recordKnowledgeUsageV1\(\{[\s\S]*?\}\)\.catch\(\(\) => \{ \/\* tolerant per-item \*\/ \}\)/.test(consumer), 'per-item failure boundary drifted')
check('consumer uses exact versioned public entry point', consumer.includes("from '@/modules/ai-knowledge/public/v1'") && consumer.includes("from '@/contracts/ai-knowledge/v1'"), 'public version import absent')
check('command amendment exact', amendment.amendments.length === 1 && amendment.amendments[0].context === 'ai_knowledge' && amendment.amendments[0].add_commands?.length === 1 && amendment.amendments[0].add_commands[0] === 'RecordKnowledgeUsageCommand.v1', 'command amendment drifted')
check('Messaging AI Knowledge dependency pre-approved', messaging.allowed_dependencies.some((item) => item.context === 'ai_knowledge' && item.surface === 'ai_knowledge.public'), 'approved dependency absent')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
