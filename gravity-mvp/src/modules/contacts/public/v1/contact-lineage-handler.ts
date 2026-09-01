export interface ContactLineagePersistencePortV1 {
  findRedirect(contactId: string): Promise<{ id: string; mergedIntoContactId: string | null } | null>
  findMergedContactIds(survivorId: string): Promise<string[]>
}

export type ContactLineageV1 = {
  requestedContactId: string
  canonicalContactId: string
  contactIds: string[]
}

export function createResolveContactLineageHandlerV1(port: ContactLineagePersistencePortV1) {
  return async (requestedContactId: string): Promise<ContactLineageV1 | null> => {
    let cursor = requestedContactId
    const visited = new Set<string>()
    for (let depth = 0; depth < 32; depth += 1) {
      if (visited.has(cursor)) throw new Error('CONTACT_MERGE_REDIRECT_CYCLE')
      visited.add(cursor)
      const contact = await port.findRedirect(cursor)
      if (!contact) return null
      if (!contact.mergedIntoContactId) {
        const mergedIds = await port.findMergedContactIds(contact.id)
        return {
          requestedContactId,
          canonicalContactId: contact.id,
          contactIds: [...new Set([contact.id, ...mergedIds])].sort(),
        }
      }
      cursor = contact.mergedIntoContactId
    }
    throw new Error('CONTACT_MERGE_REDIRECT_DEPTH_EXCEEDED')
  }
}
