import { DriverMatchService } from '@/lib/DriverMatchService'

export interface ChannelDriverMatchIdentityV1 {
    telegramId?: string | bigint | null
    phone?: string | null
    name?: string | null
}

export type LinkMatchedDriverChatV1 = (input: {
    chatId: string
    driverId: string
}) => Promise<{ linked: boolean }>

export const channelDriverMatchV1 = Object.freeze({
    linkChatToDriver: (
        chatId: string,
        identity: ChannelDriverMatchIdentityV1,
        linkMatchedDriver: LinkMatchedDriverChatV1,
    ): Promise<boolean> => DriverMatchService.linkChatToDriver(chatId, identity, linkMatchedDriver),
})
