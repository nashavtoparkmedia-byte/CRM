export const RECORD_BOT_USER_PROFILE_COMMAND_V1 = 'telegram_channel.RecordBotUserProfileCommand.v1' as const
export const RECORD_BOT_USER_PROFILE_RESULT_V1 = 'telegram_channel.RecordBotUserProfileResult.v1' as const

export interface RecordBotUserProfileCommandV1 {
    contract: typeof RECORD_BOT_USER_PROFILE_COMMAND_V1
    telegramId: bigint
    username: string | null
    firstName: string | null
    lastName: string | null
    observedAt: Date
}

export interface RecordBotUserProfileResultV1 {
    contract: typeof RECORD_BOT_USER_PROFILE_RESULT_V1
    recorded: true
}

export function parseRecordBotUserProfileCommandV1(input: unknown): RecordBotUserProfileCommandV1 {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('command must be an object')
    const value = input as Record<string, unknown>
    const fields = ['contract', 'telegramId', 'username', 'firstName', 'lastName', 'observedAt']
    if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('unsupported field')
    if (value.contract !== RECORD_BOT_USER_PROFILE_COMMAND_V1) throw new Error('unsupported contract')
    if (typeof value.telegramId !== 'bigint' || value.telegramId <= 0n) throw new Error('telegramId is invalid')
    for (const key of ['username', 'firstName', 'lastName'] as const) {
        if (value[key] !== null && typeof value[key] !== 'string') throw new Error(`${key} is invalid`)
    }
    if (!(value.observedAt instanceof Date) || Number.isNaN(value.observedAt.getTime())) throw new Error('observedAt is invalid')
    return value as unknown as RecordBotUserProfileCommandV1
}
