/** Canonical stable key for a WhatsApp private provider identity. */
export function canonicalWhatsAppIdentityExternalIdV1(rawJid: string): string {
  if (!rawJid) return rawJid
  if (/@lid$/i.test(rawJid)) return rawJid
  const phoneJid = /^([0-9]+)@c\.us$/i.exec(rawJid)
  if (!phoneJid) return rawJid
  const digits = phoneJid[1]
  return digits.length >= 10 ? `7${digits.slice(-10)}@c.us` : rawJid
}

/**
 * Exact unified Chat key for a provider identity/alias. Opaque LIDs remain
 * opaque; malformed, group, and bare legacy values cannot authorize a target.
 */
export function canonicalWhatsAppConversationTargetV1(providerIdentity: string): string | null {
  const phoneJid = /^([0-9]+)@c\.us$/i.exec(providerIdentity)
  if (phoneJid) {
    const digits = phoneJid[1]
    return digits.length >= 10 ? `whatsapp:7${digits.slice(-10)}` : null
  }
  return /^[^\s@]+@lid$/i.test(providerIdentity) ? providerIdentity : null
}
