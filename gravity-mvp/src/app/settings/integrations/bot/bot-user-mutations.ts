export type BotUserDeleteMutation =
    | { action: 'unlink'; telegramId: string }
    | { action: 'dismiss'; requestId: string }

export async function deleteBotUserMutation(mutation: BotUserDeleteMutation): Promise<void> {
    const response = await fetch('/api/bot-users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mutation),
    })
    if (response.ok) return

    const payload: unknown = await response.json().catch(() => null)
    const message = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        && typeof (payload as Record<string, unknown>).error === 'string'
        ? (payload as Record<string, string>).error
        : 'Не удалось выполнить операцию'
    throw new Error(message)
}
