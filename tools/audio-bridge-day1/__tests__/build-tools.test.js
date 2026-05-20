// Regression for llm.buildTools(scenario) (PR #57).
//
// Locks the contract that:
//   1. scenarios without outcomeSchema get the legacy free-form TOOLS
//      (back-compat with all existing scenarios)
//   2. scenarios WITH outcomeSchema get a deep-cloned tool array where
//      save_lead_data.field is an enum of canonical keys
//   3. other tools (end_call, transfer_to_manager) are not mutated
//   4. concurrent sessions don't poison each other (deep clone, not
//      mutate-in-place)
//
// Run: `node --test __tests__/build-tools.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../llm-client')

function findTool(tools, name) {
    return tools.find(t => t?.function?.name === name)
}

// ════════════════════════════════════════════════════════════════════
// Back-compat: no outcomeSchema → module-level TOOLS
// ════════════════════════════════════════════════════════════════════

test('scenario without outcomeSchema → returns module TOOLS verbatim', () => {
    const tools = llm.buildTools({ id: 's1', name: 'legacy', questions: [] })
    // Reference equality: no clone, no allocation.
    assert.equal(tools, llm.TOOLS)
})

test('scenario with empty outcomeSchema.fields → returns module TOOLS', () => {
    const tools = llm.buildTools({ outcomeSchema: { fields: [] } })
    assert.equal(tools, llm.TOOLS)
})

test('null / undefined scenario → returns module TOOLS', () => {
    assert.equal(llm.buildTools(null), llm.TOOLS)
    assert.equal(llm.buildTools(undefined), llm.TOOLS)
})

// ════════════════════════════════════════════════════════════════════
// outcomeSchema present → save_lead_data.field constrained
// ════════════════════════════════════════════════════════════════════

test('outcomeSchema with 3 fields → save_lead_data.field enum locks keys', () => {
    const scenario = {
        outcomeSchema: {
            fields: [
                { key: 'hasLicenseB', type: 'boolean', required: true },
                { key: 'experienceYears', type: 'integer', required: false },
                { key: 'city', type: 'string', required: false },
            ],
        },
    }
    const tools = llm.buildTools(scenario)

    // Returned array is a deep clone, NOT the module-level TOOLS.
    assert.notEqual(tools, llm.TOOLS)

    const sld = findTool(tools, 'save_lead_data')
    assert.ok(sld, 'save_lead_data tool present')
    assert.ok(sld.function.parameters.properties.field.enum, '.field has enum')
    assert.deepEqual(
        sld.function.parameters.properties.field.enum,
        ['hasLicenseB', 'experienceYears', 'city'],
    )
})

test('end_call and transfer_to_manager tools NOT mutated by buildTools', () => {
    const scenario = {
        outcomeSchema: {
            fields: [{ key: 'hasLicenseB', type: 'boolean', required: true }],
        },
    }
    const tools = llm.buildTools(scenario)

    const endCall = findTool(tools, 'end_call')
    const transfer = findTool(tools, 'transfer_to_manager')
    const modEndCall = findTool(llm.TOOLS, 'end_call')
    const modTransfer = findTool(llm.TOOLS, 'transfer_to_manager')

    assert.deepEqual(endCall, modEndCall, 'end_call schema preserved')
    assert.deepEqual(transfer, modTransfer, 'transfer_to_manager schema preserved')
})

test('end_call schema contains qualification_score (PR #57)', () => {
    // Regression on the LLM tool schema itself — the optional score arg
    // must remain reachable so the model can populate it.
    const endCall = findTool(llm.TOOLS, 'end_call')
    assert.ok(endCall.function.parameters.properties.qualification_score,
        'qualification_score property declared')
    assert.equal(endCall.function.parameters.properties.qualification_score.type, 'integer')
    assert.equal(endCall.function.parameters.properties.qualification_score.minimum, 0)
    assert.equal(endCall.function.parameters.properties.qualification_score.maximum, 100)
})

// ════════════════════════════════════════════════════════════════════
// Defense in depth: two concurrent sessions don't poison each other
// ════════════════════════════════════════════════════════════════════

test('two sessions with different schemas get independent tool arrays', () => {
    const sA = { outcomeSchema: { fields: [{ key: 'fieldA', type: 'string', required: true }] } }
    const sB = { outcomeSchema: { fields: [{ key: 'fieldB', type: 'string', required: true }] } }

    const toolsA = llm.buildTools(sA)
    const toolsB = llm.buildTools(sB)

    const fieldA = findTool(toolsA, 'save_lead_data').function.parameters.properties.field
    const fieldB = findTool(toolsB, 'save_lead_data').function.parameters.properties.field

    assert.deepEqual(fieldA.enum, ['fieldA'])
    assert.deepEqual(fieldB.enum, ['fieldB'])
    // Mutating one must not affect the other.
    fieldA.enum.push('mutated')
    assert.deepEqual(
        findTool(toolsB, 'save_lead_data').function.parameters.properties.field.enum,
        ['fieldB'],
    )
})

test('mutating per-scenario tools does NOT corrupt the module-level TOOLS', () => {
    const scenario = {
        outcomeSchema: { fields: [{ key: 'k1', type: 'string', required: true }] },
    }
    const tools = llm.buildTools(scenario)
    const sld = findTool(tools, 'save_lead_data')
    sld.function.description = 'CORRUPTED'

    const modSld = findTool(llm.TOOLS, 'save_lead_data')
    assert.notEqual(modSld.function.description, 'CORRUPTED',
        'module-level TOOLS.save_lead_data.description not mutated')
})

// ════════════════════════════════════════════════════════════════════
// Schema row defensiveness
// ════════════════════════════════════════════════════════════════════

test('malformed schema row (no key) → falls through to legacy TOOLS', () => {
    const scenario = {
        outcomeSchema: {
            fields: [
                { type: 'string', required: true },  // missing key — invalid row
            ],
        },
    }
    const tools = llm.buildTools(scenario)
    // canonicalKeys after .filter(Boolean) is empty → returns module TOOLS
    assert.equal(tools, llm.TOOLS)
})
