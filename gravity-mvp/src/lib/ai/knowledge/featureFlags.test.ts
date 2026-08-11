import { afterEach, describe, expect, it } from 'vitest'

import {
    getKnowledgeRuntimeMode,
    isRuntimeEnabled,
    isShadowModeEnabled,
} from './featureFlags'

const originalShadow = process.env.AI_KNOWLEDGE_SHADOW_MODE
const originalRuntime = process.env.AI_KNOWLEDGE_RUNTIME_ENABLED

afterEach(() => {
    if (originalShadow === undefined) delete process.env.AI_KNOWLEDGE_SHADOW_MODE
    else process.env.AI_KNOWLEDGE_SHADOW_MODE = originalShadow
    if (originalRuntime === undefined) delete process.env.AI_KNOWLEDGE_RUNTIME_ENABLED
    else process.env.AI_KNOWLEDGE_RUNTIME_ENABLED = originalRuntime
})

describe('AI Knowledge runtime flags', () => {
    it('keeps the fail-safe shadow-on/runtime-off defaults', () => {
        delete process.env.AI_KNOWLEDGE_SHADOW_MODE
        delete process.env.AI_KNOWLEDGE_RUNTIME_ENABLED
        expect(isShadowModeEnabled()).toBe(true)
        expect(isRuntimeEnabled()).toBe(false)
        expect(getKnowledgeRuntimeMode()).toBe('shadow')
    })

    it('preserves legacy and runtime mode precedence', () => {
        process.env.AI_KNOWLEDGE_SHADOW_MODE = 'false'
        process.env.AI_KNOWLEDGE_RUNTIME_ENABLED = 'false'
        expect(getKnowledgeRuntimeMode()).toBe('legacy')

        process.env.AI_KNOWLEDGE_SHADOW_MODE = 'false'
        process.env.AI_KNOWLEDGE_RUNTIME_ENABLED = 'true'
        expect(getKnowledgeRuntimeMode()).toBe('runtime')
    })
})
