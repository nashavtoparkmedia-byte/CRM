export class MessageService {
  static async listMessages(
    _chatIds: string | string[],
    _limit = 50,
  ): Promise<unknown[]> {
    return []
  }

  static async send(
    _chatId: string,
    _content: string,
    _channel?: unknown,
    _profileId?: string,
    _clientMessageId?: string,
    _quotedMsgId?: string,
  ): Promise<unknown> {
    return {}
  }
}
