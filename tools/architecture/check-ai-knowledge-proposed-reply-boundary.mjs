#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/ai-knowledge/v1/proposed-reply-commands.ts')
const handler = read('gravity-mvp/src/modules/ai-knowledge/public/v1/proposed-reply-handler.ts')
const adapter = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-proposed-reply-adapter.ts')
const consumer = read('gravity-mvp/src/app/messages/proposed-reply-actions.ts')
const amendment = JSON.parse(read('architecture/isolation/ai-knowledge/proposed-reply-v1/module-manifest-amendments.json'))

check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'contract leak')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'handler leak')
check('writes isolated', (adapter.match(/prisma\.aiProposedReply\.(?:upsert|update)/g) || []).length === 2 && !/prisma\.aiProposedReply\.(?:upsert|update)/.test(consumer), 'foreign write remains')
check('six owner calls', (consumer.match(/await (?:upsert|patch)ProposedReplyV1/g) || []).length === 6, 'plan not complete')
check('generation ordering retained', consumer.indexOf('generateShadowReplyForChat(chatId)') < consumer.indexOf('await upsertProposedReplyV1'), 'generation order drift')
check('upsert mapping retained', consumer.includes('messageId: lastInbound.id') && consumer.includes('sources: result.sources') && consumer.includes('expiresAt,') && consumer.includes('return serialize(saved.proposal)'), 'upsert projection drift')
check('adapter reset retained', adapter.includes('generatedAt: new Date()') && adapter.includes('dismissedAt: null') && adapter.includes('takenAt: null') && adapter.includes('sentMessageId: null'), 'regeneration reset drift')
check('taken mapping retained', consumer.includes('proposalId: id, patch: { takenAt: new Date() }'), 'taken mapping drift')
check('sent mapping retained', consumer.includes('proposalId: id, patch: { sentMessageId }'), 'sent mapping drift')
check('dismiss mapping retained', consumer.includes('proposalId: id, patch: { dismissedAt: new Date() }'), 'dismiss mapping drift')
check('both confirmation paths retained', (consumer.match(/patch: \{ confirmedCorrectAt: new Date\(\) \}/g) || []).length === 2, 'confirmation mapping drift')
check('trainer and coach remain caller-owned', consumer.includes('verifyKnowledgeItemV1') && consumer.includes('applyKnowledgeItemCoachEditV1') && consumer.includes('runCoach(') && consumer.includes('writeAuditEntry('), 'caller ownership drift')
check('reads and provider lookup remain caller-owned', consumer.includes('prisma.aiProposedReply.findUnique') && consumer.includes('prisma.message.findFirst') && consumer.includes('getAiAgentProviderConfigV1()') && !consumer.includes('prisma.aiAgentConfig.findUnique'), 'read or provider orchestration drift')
check('amendment exact', JSON.stringify(amendment.amendments[0]?.add_commands) === JSON.stringify(['UpsertProposedReplyCommand.v1', 'PatchProposedReplyCommand.v1']), 'amendment drift')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
