export interface RenderableMessageText {
  content?: string | null
  type?: string | null
}

const MEDIA_CONTENT_PLACEHOLDERS = new Set([
  '[Фото]',
  '[Видео]',
  '[Голосовое]',
  '[Аудио]',
  '[Документ]',
  '[Стикер]',
  '[Контакт]',
])

/**
 * Returns the exact operator-visible body. New messages keep forwarding and
 * reply data in metadata; prefix removal remains only for legacy rows.
 */
export function getRenderedMessageText(message: RenderableMessageText): string | null {
  const raw = (message.content || '').replace(/^\[↩ [^\]]+\]\n?/, '')
  if (MEDIA_CONTENT_PLACEHOLDERS.has(raw.trim())) return null
  return raw || null
}
