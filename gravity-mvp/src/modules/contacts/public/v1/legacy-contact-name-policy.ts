/** Exact placeholder policy retained from the MAX sync-names compatibility flow. */
export function isLegacyPlaceholderContactNameV1(name?: string | null): boolean {
    if (!name) return true
    const value = name.trim()
    if (!value) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)[\s:]+\d+$/i.test(value)) return true
    if (/^\d+$/.test(value)) return true
    if (/^[.\s\-]+$/.test(value)) return true
    return false
}
