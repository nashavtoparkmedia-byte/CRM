#!/usr/bin/env node

// R-22 Messaging read-side conversation binding trust.
//   - The binding policy is pure and has no driver key.
//   - The inbox read (MessageService.listConversations) groups by the policy's
//     one person key and never by driverId; a contradicted conversation loses
//     the other person's contact and driver in the read model.
//   - Workflow group writes (assign, unassign, resolve, mark read) write an
//     exact id list of one person's trusted conversations; no statement selects
//     its rows by "driverId" or by "contactId".
//   - The AI reply context loads a Driver only behind the binding policy and
//     Contacts' isContactConfirmedMainDriverV1.
//   - The binding audit is read-only and asks Contacts' own peer query.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const policyPath = 'gravity-mvp/src/modules/messaging/public/v1/conversation-binding-trust-policy.ts'
const messageServicePath = 'gravity-mvp/src/lib/MessageService.ts'
const workflowPath = 'gravity-mvp/src/lib/ConversationWorkflowService.ts'
const contextBuilderPath = 'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ContextBuilder.ts'
const auditAdapterPath = 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-conversation-binding-audit-adapter.ts'
const auditHandlerPath = 'gravity-mvp/src/modules/messaging/public/v1/conversation-binding-audit-handler.ts'

function body(source, startMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`${label} missing`)
  let depth = 0
  for (let index = source.indexOf('{', start + startMarker.length - 1); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${label} unterminated`)
}

function assertPurePolicy(source) {
  if (/^\s*import\s/mu.test(source)) throw new Error('policy imports')
  if (/\bawait\b|\bprisma\b|process\.env|fetch\(/u.test(source)) throw new Error('policy performs IO')
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  if (/driverId|`d:/u.test(code)) throw new Error('policy has a driver key')
  if (!/return isConversationPersonTrustedV1\(state\) \? `c:\$\{facts\.contactId\}` : null/u.test(source)) throw new Error('person key drift')
  if (!/if \(identity\.contactId !== facts\.contactId\) return 'contradicted'/u.test(source)) throw new Error('another contact\'s identity is not a contradiction')
  if (!/return identity\.externalId === peer \? 'consistent' : 'contradicted'/u.test(source)) throw new Error('Telegram peer check drift')
  if (!/return state === 'consistent' \|\| state === 'unverifiable'/u.test(source)) throw new Error('trusted states drift')
}

function assertInbox(source) {
  const list = body(source, 'static async listConversations() {', 'listConversations')
  if (/`d:\$\{/u.test(list) || /chat\.driverId \?/u.test(list)) throw new Error('the inbox groups by driverId')
  if (!/const personGroupKey = personGroupKeys\.get\(chat\.id\) \?\? null\n\s+const keys = personGroupKey \? \[personGroupKey\] : \[\]/u.test(list)) throw new Error('the inbox does not group by the policy key')
  if (!/personGroupKeys\.set\(chat\.id, conversationPersonGroupKeyV1\(facts\)\)/u.test(list)) throw new Error('the person key is not the policy key')
  const contradicted = /if \(chat\.personBinding === 'contradicted'\) \{([^}]*)\}/u.exec(list)?.[1] ?? ''
  for (const field of ['contact', 'contactId', 'contactIdentityId', 'driver', 'driverId']) {
    if (!new RegExp(`chat\\.${field} = null`, 'u').test(contradicted)) throw new Error(`a contradicted conversation keeps ${field}`)
  }
  if (!/contactIdentity: \{\s+select: \{ id: true, channel: true, externalId: true, contactId: true, isActive: true \},/u.test(list)) throw new Error('the inbox does not read the linked identity')
}

function assertWorkflow(source) {
  if (/kind: 'driver'/u.test(source)) throw new Error('a driver group selector exists')
  if (/WHERE\s+"driverId"/u.test(source)) throw new Error('a workflow statement selects by driverId')
  if (/WHERE\s+"contactId"/u.test(source)) throw new Error('a workflow statement selects by contactId instead of trusted ids')
  for (const name of ['_assignGroup', '_unassignGroup', '_resolveGroup', '_markGroupRead']) {
    const group = body(source, `private static async ${name}(`, name)
    if (!/WHERE id = ANY\(\$\{selector\.chatIds\}\)/u.test(group)) throw new Error(`${name} does not write an exact trusted id list`)
  }
  const selector = body(source, 'private static async _getGroupSelector(', '_getGroupSelector')
  if (!/if \(!chat\.contactId \|\| !isConversationPersonTrustedV1\(bindingState\(chat\)\)\) return \{ chatIds: \[chatId\] \}/u.test(selector)) throw new Error('an untrusted conversation reaches a group')
  if (!/siblings\.filter\(sibling => isConversationPersonTrustedV1\(bindingState\(sibling\)\)\)/u.test(selector)) throw new Error('a contradicted sibling is reached by a group write')
}

function assertContextBuilder(source) {
  if (!/&& isConversationPersonTrustedV1\(bindingState\)\n\s+&& await isContactConfirmedMainDriverV1\(row\.contactId, row\.driverId\),/u.test(source)) throw new Error('the AI context loads a Driver without Contacts\' confirmation')
  if (!/driverId: driverProven \? row\.driverId : null/u.test(source)) throw new Error('an unproven driverId reaches the AI context')
  if (/where:\s+\{ id: row\.driverId \}/u.test(source)) throw new Error('the AI context loads the unproven driver')
}

function assertReadOnlyAudit(adapter, handler) {
  if (/\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/u.test(adapter)) throw new Error('the binding audit writes')
  if (!/resolveInboundConversationPeerIdentityV1\(\{\s+contract: RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1,/u.test(adapter)) throw new Error('the audit does not ask Contacts\' own peer query')
  if (/prisma|\.findMany\(|\.findUnique\(/u.test(handler)) throw new Error('the audit handler reaches persistence')
}

const policy = read(policyPath)
const messageService = read(messageServicePath)
const workflow = read(workflowPath)
const contextBuilder = read(contextBuilderPath)
const auditAdapter = read(auditAdapterPath)
const auditHandler = read(auditHandlerPath)

assertPurePolicy(policy)
assertInbox(messageService)
assertWorkflow(workflow)
assertContextBuilder(contextBuilder)
assertReadOnlyAudit(auditAdapter, auditHandler)

let probes = 0
function rejectProbe(original, changed, check) {
  assert.notEqual(changed, original, 'probe did not change its source')
  assert.throws(() => check(changed), `probe accepted:\n${changed.slice(0, 160)}`)
  probes += 1
}

rejectProbe(policy, `import { prisma } from '@/lib/prisma'\n${policy}`, assertPurePolicy)
rejectProbe(policy, policy.replace('  contactIdentityId: string | null\n  /**', '  contactIdentityId: string | null\n  driverId: string | null\n  /**'), assertPurePolicy)
rejectProbe(policy, policy.replace("if (identity.contactId !== facts.contactId) return 'contradicted'", "if (identity.contactId !== facts.contactId) return 'unverifiable'"), assertPurePolicy)
rejectProbe(policy, policy.replace("return identity.externalId === peer ? 'consistent' : 'contradicted'", "return 'consistent'"), assertPurePolicy)
rejectProbe(policy, policy.replace("return state === 'consistent' || state === 'unverifiable'", "return state !== 'unbound'"), assertPurePolicy)
rejectProbe(messageService, messageService.replace('const keys = personGroupKey ? [personGroupKey] : []', 'const keys = [personGroupKey, chat.driverId ? `d:${chat.driverId}` : null].filter(Boolean) as string[]'), assertInbox)
rejectProbe(messageService, messageService.replace('                    chat.driver = null\n', ''), assertInbox)
rejectProbe(messageService, messageService.replace('                    chat.contactId = null\n', ''), assertInbox)
rejectProbe(workflow, workflow.replace('WHERE id = ANY(${selector.chatIds})', 'WHERE "contactId" = ANY(${selector.chatIds})'), assertWorkflow)
rejectProbe(workflow, `${workflow}\nconst rogue = 'UPDATE "Chat" SET "unreadCount" = 0 WHERE "driverId" = $1'\n`, assertWorkflow)
rejectProbe(workflow, workflow.replace('siblings.filter(sibling => isConversationPersonTrustedV1(bindingState(sibling)))', 'siblings'), assertWorkflow)
rejectProbe(workflow, workflow.replace('if (!chat.contactId || !isConversationPersonTrustedV1(bindingState(chat))) return { chatIds: [chatId] }', 'if (!chat.contactId) return { chatIds: [chatId] }'), assertWorkflow)
rejectProbe(contextBuilder, contextBuilder.replace('      && await isContactConfirmedMainDriverV1(row.contactId, row.driverId),\n', ''), assertContextBuilder)
rejectProbe(contextBuilder, contextBuilder.replace('driverId: driverProven ? row.driverId : null', 'driverId: row.driverId'), assertContextBuilder)
rejectProbe(auditAdapter, `${auditAdapter}\nawait prisma.chat.update({ where: { id }, data: { contactId: null } })\n`, (changed) => assertReadOnlyAudit(changed, auditHandler))
rejectProbe(auditHandler, `import { prisma } from '@/lib/prisma'\n${auditHandler}`, (changed) => assertReadOnlyAudit(auditAdapter, changed))

process.stdout.write(`messaging binding trust boundary: PASS (no driver key, contradicted stands alone, trusted-id group writes, Contacts-confirmed AI driver, read-only audit; ${probes} negative probes rejected)\n`)
