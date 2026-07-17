export class ContactService {
  static async resolveContact(...args: unknown[]): Promise<{
    contact: { id: string }
    identity: { id: string }
    isNew: boolean
  }> {
    void args
    return { contact: { id: '' }, identity: { id: '' }, isNew: false }
  }

  static async ensureChatLinked(...args: unknown[]): Promise<void> {
    void args
  }
}
