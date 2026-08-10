export const CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1 = 'ai_knowledge.CreateLegacyKnowledgeEntryCommand.v1' as const
export const CREATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1 = 'ai_knowledge.CreateLegacyKnowledgeEntryResult.v1' as const
export const UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1 = 'ai_knowledge.UpdateLegacyKnowledgeEntryCommand.v1' as const
export const UPDATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1 = 'ai_knowledge.UpdateLegacyKnowledgeEntryResult.v1' as const
export const DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1 = 'ai_knowledge.DeleteLegacyKnowledgeEntryCommand.v1' as const
export const DELETE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1 = 'ai_knowledge.DeleteLegacyKnowledgeEntryResult.v1' as const

export interface LegacyKnowledgeEntryCreateV1 {
    title: string
    category: string
    sampleQuestions: string[]
    answer: string
    tags: string[]
    channels: string[]
    priority: number
}

export interface LegacyKnowledgeEntryPatchV1 {
    title?: string
    category?: string
    sampleQuestions?: string[]
    answer?: string
    tags?: string[]
    channels?: string[]
    active?: boolean
    priority?: number
}

export interface CreateLegacyKnowledgeEntryCommandV1 {
    contract: typeof CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1
    entryId: string
    data: LegacyKnowledgeEntryCreateV1
}

export interface CreateLegacyKnowledgeEntryResultV1 {
    contract: typeof CREATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1
    created: true
}

export interface UpdateLegacyKnowledgeEntryCommandV1 {
    contract: typeof UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1
    entryId: string
    patch: LegacyKnowledgeEntryPatchV1
}

export interface UpdateLegacyKnowledgeEntryResultV1 {
    contract: typeof UPDATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1
    updated: boolean
}

export interface DeleteLegacyKnowledgeEntryCommandV1 {
    contract: typeof DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1
    entryId: string
}

export interface DeleteLegacyKnowledgeEntryResultV1 {
    contract: typeof DELETE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1
    deleted: true
}

export class LegacyKnowledgeEntryCommandValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: LegacyKnowledgeEntryCommandValidationError['code'], message: string) {
        super(message)
        this.name = 'LegacyKnowledgeEntryCommandValidationError'
        this.code = code
    }
}

const CREATE_FIELDS = ['title', 'category', 'sampleQuestions', 'answer', 'tags', 'channels', 'priority'] as const
const PATCH_FIELDS = [...CREATE_FIELDS, 'active'] as const
const STRING_FIELDS = new Set(['title', 'category', 'answer'])
const ARRAY_FIELDS = new Set(['sampleQuestions', 'tags', 'channels'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new LegacyKnowledgeEntryCommandValidationError('INVALID_CONTRACT', message)
}

function envelope(input: unknown, expected: string, prefix: string, fields: string[]): Record<string, unknown> {
    if (!isRecord(input)) invalid('command must be an object')
    const extra = Object.keys(input).filter((key) => !fields.includes(key))
    if (extra.length) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new LegacyKnowledgeEntryCommandValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

function object(value: unknown, key: string, allowed: readonly string[]): Record<string, unknown> {
    if (!isRecord(value)) invalid(`${key} must be an object`)
    const extra = Object.keys(value).filter((field) => !allowed.includes(field))
    if (extra.length) invalid(`unsupported ${key} field(s): ${extra.sort().join(', ')}`)
    return value
}

function stringArray(value: unknown, key: string): void {
    if (!Array.isArray(value)) invalid(`${key} must be an array of strings`)
    for (let index = 0; index < value.length; index += 1) {
        if (typeof value[index] !== 'string') invalid(`${key} must be an array of strings`)
    }
}

function validateField(key: string, value: unknown, prefix: string): void {
    if (STRING_FIELDS.has(key)) {
        if (typeof value !== 'string') invalid(`${prefix}.${key} must be a string`)
        return
    }
    if (ARRAY_FIELDS.has(key)) {
        stringArray(value, `${prefix}.${key}`)
        return
    }
    if (key === 'active') {
        if (typeof value !== 'boolean') invalid(`${prefix}.active must be a boolean`)
        return
    }
    if (key === 'priority' && (typeof value !== 'number' || !Number.isInteger(value))) {
        invalid(`${prefix}.priority must be an integer`)
    }
}

function entryId(value: unknown): void {
    if (typeof value !== 'string' || value.trim() === '') invalid('entryId must be a non-empty string')
}

export function parseCreateLegacyKnowledgeEntryCommandV1(input: unknown): CreateLegacyKnowledgeEntryCommandV1 {
    const command = envelope(
        input,
        CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
        'ai_knowledge.CreateLegacyKnowledgeEntryCommand.',
        ['contract', 'entryId', 'data'],
    )
    entryId(command.entryId)
    const data = object(command.data, 'data', CREATE_FIELDS)
    for (const field of CREATE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(data, field)) invalid(`data.${field} is required`)
        validateField(field, data[field], 'data')
    }
    return command as unknown as CreateLegacyKnowledgeEntryCommandV1
}

export function parseUpdateLegacyKnowledgeEntryCommandV1(input: unknown): UpdateLegacyKnowledgeEntryCommandV1 {
    const command = envelope(
        input,
        UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
        'ai_knowledge.UpdateLegacyKnowledgeEntryCommand.',
        ['contract', 'entryId', 'patch'],
    )
    entryId(command.entryId)
    const patch = object(command.patch, 'patch', PATCH_FIELDS)
    for (const [field, value] of Object.entries(patch)) validateField(field, value, 'patch')
    return command as unknown as UpdateLegacyKnowledgeEntryCommandV1
}

export function parseDeleteLegacyKnowledgeEntryCommandV1(input: unknown): DeleteLegacyKnowledgeEntryCommandV1 {
    const command = envelope(
        input,
        DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
        'ai_knowledge.DeleteLegacyKnowledgeEntryCommand.',
        ['contract', 'entryId'],
    )
    entryId(command.entryId)
    return command as unknown as DeleteLegacyKnowledgeEntryCommandV1
}
