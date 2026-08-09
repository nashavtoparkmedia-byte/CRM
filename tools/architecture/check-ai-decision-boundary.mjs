#!/usr/bin/env node
import fs from 'node:fs'
const read = (f) => fs.readFileSync(f, 'utf8'); const checks = []; const failures = []; const check = (n, v, d) => v ? checks.push(n) : failures.push({ check: n, detail: d })
const contract = read('gravity-mvp/src/contracts/ai-knowledge/v1/record-ai-decision-command.ts'); const handler = read('gravity-mvp/src/modules/ai-knowledge/public/v1/record-ai-decision-handler.ts'); const adapter = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-record-ai-decision-adapter.ts'); const consumer = read('gravity-mvp/src/lib/pipeline/PipelineWorker.ts'); const platform = JSON.parse(read('architecture/contexts/v1/manifests/platform_shell.json')); const amendment = JSON.parse(read('architecture/isolation/ai-knowledge/decision-log-v1/module-manifest-amendments.json'))
check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked')
check('write isolated', adapter.includes('INSERT INTO "AiDecisionLog"') && !consumer.includes('INSERT INTO "AiDecisionLog"'), 'foreign insert remains')
check('JSON casts retained', adapter.includes('usedKnowledgeEntriesJson}::jsonb') && adapter.includes('shadowRetrievalSummaryJson}::jsonb'), 'JSON mapping drifted')
check('DB timestamp retained', adapter.includes('NOW()'), 'timestamp drifted')
check('model selection retained', consumer.includes("decision.decision === 'auto_reply' ? ctx.config.responseModel : ctx.config.classificationModel"), 'model rule drifted')
check('escalation mapping retained', consumer.includes("escalated: decision.decision === 'escalate'"), 'escalation rule drifted')
check('nonblocking error log retained', consumer.includes(".catch(e => console.error('[Pipeline] AiDecisionLog write error:', e.message))"), 'tolerance drifted')
check('usage follows decision attempt', consumer.indexOf('await recordAiDecisionV1({') < consumer.indexOf('if (ctx.knowledgeRetrieval)'), 'ordering drifted')
check('exact public imports', consumer.includes("from '@/modules/ai-knowledge/public/v1'") && consumer.includes("from '@/contracts/ai-knowledge/v1'"), 'versioned import absent')
check('amendment exact', amendment.amendments[0]?.context === 'ai_knowledge' && amendment.amendments[0]?.add_commands?.[0] === 'RecordAiDecisionCommand.v1', 'amendment drifted')
check('dependency pre-approved', platform.allowed_dependencies.some((x) => x.context === 'ai_knowledge' && x.surface === 'ai_knowledge.public'), 'dependency absent')
process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`); if (failures.length) process.exitCode = 1
