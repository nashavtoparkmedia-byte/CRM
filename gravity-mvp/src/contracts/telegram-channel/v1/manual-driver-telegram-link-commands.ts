export const SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1 =
    'telegram_channel.SaveManualDriverTelegramLinkCommand.v1' as const
export const SAVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1 =
    'telegram_channel.SaveManualDriverTelegramLinkResult.v1' as const
export const REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1 =
    'telegram_channel.RemoveManualDriverTelegramLinkCommand.v1' as const
export const REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1 =
    'telegram_channel.RemoveManualDriverTelegramLinkResult.v1' as const
export const NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1 =
    'telegram_channel.NotifyManualDriverTelegramLinkCommand.v1' as const
export const NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1 =
    'telegram_channel.NotifyManualDriverTelegramLinkResult.v1' as const

export interface SaveManualDriverTelegramLinkCommandV1 {
    contract: typeof SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1
    driverId: string
    telegramId: bigint
}

export interface SaveManualDriverTelegramLinkResultV1 {
    contract: typeof SAVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1
    saved: true
}

export interface RemoveManualDriverTelegramLinkCommandV1 {
    contract: typeof REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1
    driverId: string
}

export interface RemoveManualDriverTelegramLinkResultV1 {
    contract: typeof REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1
    removed: true
}

export interface NotifyManualDriverTelegramLinkCommandV1 {
    contract: typeof NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1
    telegramId: bigint
    driverName: string
}

export interface NotifyManualDriverTelegramLinkResultV1 {
    contract: typeof NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1
    notified: true
}

export class ManualDriverTelegramLinkCommandValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ManualDriverTelegramLinkCommandValidationError['code'], message: string) {
        super(message)
        this.name = 'ManualDriverTelegramLinkCommandValidationError'
        this.code = code
    }
}

function invalid(message: string): never {
    throw new ManualDriverTelegramLinkCommandValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function envelope(
    input: unknown,
    expected: string,
    prefix: string,
    fields: readonly string[],
): Record<string, unknown> {
    if (!isRecord(input)) invalid('command must be an object')
    const extra = Object.keys(input).filter((field) => !fields.includes(field))
    if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new ManualDriverTelegramLinkCommandValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

function requireDriverId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') invalid('driverId is required')
}

export function parseSaveManualDriverTelegramLinkCommandV1(
    input: unknown,
): SaveManualDriverTelegramLinkCommandV1 {
    const value = envelope(
        input,
        SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
        'telegram_channel.SaveManualDriverTelegramLinkCommand.',
        ['contract', 'driverId', 'telegramId'],
    )
    requireDriverId(value.driverId)
    if (typeof value.telegramId !== 'bigint') invalid('telegramId must be a bigint')
    return value as unknown as SaveManualDriverTelegramLinkCommandV1
}

export function parseRemoveManualDriverTelegramLinkCommandV1(
    input: unknown,
): RemoveManualDriverTelegramLinkCommandV1 {
    const value = envelope(
        input,
        REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
        'telegram_channel.RemoveManualDriverTelegramLinkCommand.',
        ['contract', 'driverId'],
    )
    requireDriverId(value.driverId)
    return value as unknown as RemoveManualDriverTelegramLinkCommandV1
}

export function parseNotifyManualDriverTelegramLinkCommandV1(
    input: unknown,
): NotifyManualDriverTelegramLinkCommandV1 {
    const value = envelope(
        input,
        NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
        'telegram_channel.NotifyManualDriverTelegramLinkCommand.',
        ['contract', 'telegramId', 'driverName'],
    )
    if (typeof value.telegramId !== 'bigint') invalid('telegramId must be a bigint')
    if (typeof value.driverName !== 'string' || value.driverName.length === 0) {
        invalid('driverName is required')
    }
    return value as unknown as NotifyManualDriverTelegramLinkCommandV1
}
