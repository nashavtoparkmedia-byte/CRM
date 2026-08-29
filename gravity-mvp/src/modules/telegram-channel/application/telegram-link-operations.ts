import {
    createDismissBotLinkRequestHandlerV1,
    createRecordPendingBotLinkRequestHandlerV1,
} from '../public/v1/bot-chat-message-handler'
import { legacyPrismaBotChatMessagePortV1 } from '../public/v1/legacy-prisma-bot-chat-message-adapter'
import {
    createDeleteDriverTelegramLinkHandlerV1,
    createPatchDriverTelegramLinkHandlerV1,
    createReplaceDriverTelegramLinkHandlerV1,
    createUpsertDriverTelegramLinkHandlerV1,
} from '../public/v1/driver-telegram-handler'
import { legacyPrismaDriverTelegramPortV1 } from '../public/v1/legacy-prisma-driver-telegram-adapter'
import {
    createRemoveManualDriverTelegramLinkHandlerV1,
    createSaveManualDriverTelegramLinkHandlerV1,
} from '../public/v1/manual-driver-telegram-link-handler'
import { legacyPrismaManualDriverTelegramLinkPortV1 } from '../public/v1/legacy-prisma-manual-driver-telegram-link-adapter'
import { createNotifyManualDriverTelegramLinkHandlerV1 } from '../public/v1/manual-driver-telegram-link-notification-handler'
import { legacyBotApiManualDriverTelegramLinkNotificationPortV1 } from '../public/v1/legacy-bot-api-manual-driver-telegram-link-notification-adapter'
import { createGetBotUserLinkStatusHandlerV1, createRecordBotUserProfileHandlerV1 } from '../public/v1/bot-user-profile-handler'
import { legacyPrismaBotUserProfilePortV1 } from '../public/v1/legacy-prisma-bot-user-profile-adapter'

const dismissBotLinkRequest = createDismissBotLinkRequestHandlerV1(legacyPrismaBotChatMessagePortV1)
const recordPendingBotLinkRequest = createRecordPendingBotLinkRequestHandlerV1(legacyPrismaBotChatMessagePortV1)
const replaceDriverTelegramLink = createReplaceDriverTelegramLinkHandlerV1(legacyPrismaDriverTelegramPortV1)
const deleteDriverTelegramLink = createDeleteDriverTelegramLinkHandlerV1(legacyPrismaDriverTelegramPortV1)
const patchDriverTelegramLink = createPatchDriverTelegramLinkHandlerV1(legacyPrismaDriverTelegramPortV1)
const upsertDriverTelegramLink = createUpsertDriverTelegramLinkHandlerV1(legacyPrismaDriverTelegramPortV1)
const saveManualDriverTelegramLink = createSaveManualDriverTelegramLinkHandlerV1(legacyPrismaManualDriverTelegramLinkPortV1)
const removeManualDriverTelegramLink = createRemoveManualDriverTelegramLinkHandlerV1(legacyPrismaManualDriverTelegramLinkPortV1)
const notifyManualDriverTelegramLink = createNotifyManualDriverTelegramLinkHandlerV1(legacyBotApiManualDriverTelegramLinkNotificationPortV1)
const recordBotUserProfile = createRecordBotUserProfileHandlerV1(legacyPrismaBotUserProfilePortV1)
const getBotUserLinkStatus = createGetBotUserLinkStatusHandlerV1(legacyPrismaBotUserProfilePortV1)

export const dismissBotLinkRequestV1 = (...args: Parameters<typeof dismissBotLinkRequest>) => dismissBotLinkRequest(...args)
export const recordPendingBotLinkRequestV1 = (...args: Parameters<typeof recordPendingBotLinkRequest>) => recordPendingBotLinkRequest(...args)
export const replaceDriverTelegramLinkV1 = (...args: Parameters<typeof replaceDriverTelegramLink>) => replaceDriverTelegramLink(...args)
export const deleteDriverTelegramLinkV1 = (...args: Parameters<typeof deleteDriverTelegramLink>) => deleteDriverTelegramLink(...args)
export const patchDriverTelegramLinkV1 = (...args: Parameters<typeof patchDriverTelegramLink>) => patchDriverTelegramLink(...args)
export const upsertDriverTelegramLinkV1 = (...args: Parameters<typeof upsertDriverTelegramLink>) => upsertDriverTelegramLink(...args)
export const saveManualDriverTelegramLinkV1 = (...args: Parameters<typeof saveManualDriverTelegramLink>) => saveManualDriverTelegramLink(...args)
export const removeManualDriverTelegramLinkV1 = (...args: Parameters<typeof removeManualDriverTelegramLink>) => removeManualDriverTelegramLink(...args)
export const notifyManualDriverTelegramLinkV1 = (...args: Parameters<typeof notifyManualDriverTelegramLink>) => notifyManualDriverTelegramLink(...args)
export const recordBotUserProfileV1 = (...args: Parameters<typeof recordBotUserProfile>) => recordBotUserProfile(...args)
export const getBotUserLinkStatusV1 = (...args: Parameters<typeof getBotUserLinkStatus>) => getBotUserLinkStatus(...args)
