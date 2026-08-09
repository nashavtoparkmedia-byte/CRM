#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd(); const out = mkdtempSync(path.join(tmpdir(), 'yoko-ai-decision-'))
const sources = ['gravity-mvp/src/contracts/ai-knowledge/v1/record-ai-decision-command.ts', 'gravity-mvp/src/contracts/ai-knowledge/v1/index.ts', 'gravity-mvp/src/modules/ai-knowledge/public/v1/record-ai-decision-handler.ts'].map((v) => path.join(root, v))
const compile = spawnSync(process.execPath, [path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'), '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', out, ...sources], { encoding: 'utf8' })
if (compile.status !== 0) { process.stderr.write(compile.stdout + compile.stderr); process.exit(1) }
const require = createRequire(import.meta.url)
const c = require(path.join(out, 'contracts/ai-knowledge/v1/index.js'))
const { createRecordAiDecisionHandlerV1 } = require(path.join(out, 'modules/ai-knowledge/public/v1/record-ai-decision-handler.js'))
const checks = []; const check = (n, fn) => { fn(); checks.push(n) }; const checkAsync = async (n, fn) => { await fn(); checks.push(n) }
try {
  const command = { contract: c.RECORD_AI_DECISION_COMMAND_V1, id: 'adl_1', messageId: 'm1', chatId: 'c1', channel: 'whatsapp', detectedIntent: 'price', confidence: 0.8, decision: 'auto_reply', selectedModel: 'model', usedKnowledgeEntriesJson: '["kb1"]', generatedReply: 'ok', replySent: true, escalated: false, error: null, retrievalMode: 'runtime', retrievalDecision: 'answer', escalationReason: null, knowledgeRuntimeVersion: 'v1', shadowRetrievalSummaryJson: null }
  check('identifier explicit', () => assert.equal(c.RECORD_AI_DECISION_COMMAND_V1, 'ai_knowledge.RecordAiDecisionCommand.v1'))
  check('valid parses unchanged', () => assert.deepEqual(c.parseRecordAiDecisionCommandV1(command), command))
  check('all decisions accepted', () => ['auto_reply', 'escalate', 'skip'].forEach((decision) => c.parseRecordAiDecisionCommandV1({ ...command, decision })))
  check('v2 rejected', () => assert.throws(() => c.parseRecordAiDecisionCommandV1({ ...command, contract: 'ai_knowledge.RecordAiDecisionCommand.v2' }), (e) => e.code === 'UNSUPPORTED_CONTRACT_VERSION'))
  check('unknown field rejected', () => assert.throws(() => c.parseRecordAiDecisionCommandV1({ ...command, provider: 'x' })))
  check('nonfinite confidence rejected', () => assert.throws(() => c.parseRecordAiDecisionCommandV1({ ...command, confidence: NaN })))
  check('invalid JSON rejected', () => assert.throws(() => c.parseRecordAiDecisionCommandV1({ ...command, usedKnowledgeEntriesJson: '[' })))
  const writes = []; const handler = createRecordAiDecisionHandlerV1({ async append(input) { writes.push(input) } })
  const result = await handler(command)
  check('contract removed at owner port', () => { assert.equal(writes.length, 1); assert.equal('contract' in writes[0], false); assert.equal(writes[0].decision, 'auto_reply') })
  check('versioned result returned', () => assert.deepEqual(result, { contract: c.RECORD_AI_DECISION_RESULT_V1, recorded: true }))
  await checkAsync('invalid never persists', async () => { const n = writes.length; await assert.rejects(handler({ ...command, replySent: 'yes' })); assert.equal(writes.length, n) })
  await checkAsync('owner failure visible', async () => { const failing = createRecordAiDecisionHandlerV1({ async append() { throw new Error('down') } }); await assert.rejects(failing(command), /down/) })
} finally { rmSync(out, { recursive: true, force: true }) }
process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
