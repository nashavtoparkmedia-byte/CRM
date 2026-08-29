import {
    RECORD_BOT_USER_PROFILE_RESULT_V1,
    parseRecordBotUserProfileCommandV1,
    type RecordBotUserProfileCommandV1,
    type RecordBotUserProfileResultV1,
} from '../../../../contracts/telegram-channel/v1'

export interface BotUserProfilePersistencePortV1 {
    record(input: Omit<RecordBotUserProfileCommandV1, 'contract'>): Promise<void>
}

export function createRecordBotUserProfileHandlerV1(port: BotUserProfilePersistencePortV1) {
    return async function recordBotUserProfileV1(
        command: RecordBotUserProfileCommandV1 | unknown,
    ): Promise<RecordBotUserProfileResultV1> {
        const parsed = parseRecordBotUserProfileCommandV1(command)
        await port.record({
            telegramId: parsed.telegramId,
            username: parsed.username,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            observedAt: parsed.observedAt,
        })
        return { contract: RECORD_BOT_USER_PROFILE_RESULT_V1, recorded: true }
    }
}
