#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai/knowledge/coach.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-coach.ts'
const actionPath = 'gravity-mvp/src/app/messages/proposed-reply-actions.ts'
const componentPath = 'gravity-mvp/src/app/messages/components/AiCoachModal.tsx'
const exactFunctions = ['runKnowledgeCoachV1']

assert.equal(sha256(read(implementationPath)), '43958810ce06b730d79c15e17239b5c587e6e0aee77e48803b93191dcd471dae')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify(exactFunctions)
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /runKnowledgeCoachV1\(options:[\s\S]*?return runCoach\(options\)/)
assert.doesNotMatch(publicSource, /export \*|callForJson|COACH_SYSTEM_PROMPT|applyKnowledgeItemCoachEdit|writeAuditEntry|\bprisma\.|\$queryRaw|\$executeRaw/)

const unrelatedWriteProbe = `${publicSource}\nexport async function applyKnowledgeCoachSuggestionV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

const action = read(actionPath)
assert.match(action, /runKnowledgeCoachV1 as runCoach/)
assert.match(action, /KnowledgeCoachResultV1 as CoachResult/)
assert.match(action, /KnowledgeCoachSuggestionV1 as CoachSuggestion/)
assert.doesNotMatch(action, /@\/lib\/ai\/knowledge\/coach/)
const coachStart = action.indexOf('export async function coachFromCorrection')
const coachEnd = action.indexOf('/**\n * PR9.55 «AI Coach» apply step', coachStart)
const coachAction = action.slice(coachStart, coachEnd)
assert(coachAction.indexOf('getAiAgentProviderConfigV1()') < coachAction.indexOf('FROM "AiKnowledgeItem"'))
assert(coachAction.indexOf('FROM "AiKnowledgeItem"') < coachAction.indexOf('await runCoach({'))
assert.match(coachAction, /model:\s+config\.model \?\? 'claude-sonnet-4-5'/)
assert.match(coachAction, /items:\s+itemRows/)

const component = read(componentPath)
assert.match(component, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-coach/)
assert.doesNotMatch(component, /@\/lib\/ai\/knowledge\/coach/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeCoach.v1'))

const scan = await scanArchitecture(root)
const consumers = [actionPath, componentPath]
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
