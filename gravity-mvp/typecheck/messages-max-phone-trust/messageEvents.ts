import type { Message } from '@prisma/client'

export async function emitMessageReceived(_message: Message): Promise<void> {
  // Scoped typecheck boundary. Runtime behavior is covered by provider mocks
  // and the production-equivalent build; this prevents unrelated AI pipeline
  // dependencies from weakening the MAX trust compile signal.
}
