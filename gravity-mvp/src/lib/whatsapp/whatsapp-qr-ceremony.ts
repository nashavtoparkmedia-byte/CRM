const DEFAULT_QR_TTL_MS = 90_000
const MAX_QR_DATA_URL_LENGTH = 256_000

interface PendingWhatsAppQr {
    dataUrl: string
    instanceId: string
    expiresAt: number
}

const qrGlobal = globalThis as typeof globalThis & {
    __yokoPendingWhatsAppQrs?: Map<string, PendingWhatsAppQr>
}
const pendingQrs = qrGlobal.__yokoPendingWhatsAppQrs ?? new Map<string, PendingWhatsAppQr>()
qrGlobal.__yokoPendingWhatsAppQrs = pendingQrs

function sweepExpired(now: number): void {
    for (const [connectionId, pending] of pendingQrs) {
        if (pending.expiresAt <= now) pendingQrs.delete(connectionId)
    }
}

/**
 * Publish an ephemeral QR ceremony result. QR material is process-memory only:
 * it is never written to WhatsAppConnection.sessionData or a general-purpose
 * connection DTO.
 */
export function publishPendingWhatsAppQr(
    connectionId: string,
    instanceId: string,
    dataUrl: string,
    options: { now?: number; ttlMs?: number } = {},
): void {
    const now = options.now ?? Date.now()
    const ttlMs = options.ttlMs ?? DEFAULT_QR_TTL_MS
    if (!connectionId || !instanceId) throw new Error('WhatsApp QR identity is required')
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_QR_TTL_MS) {
        throw new Error('WhatsApp QR TTL is invalid')
    }
    if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_QR_DATA_URL_LENGTH) {
        throw new Error('WhatsApp QR payload is invalid')
    }
    sweepExpired(now)
    pendingQrs.set(connectionId, { dataUrl, instanceId, expiresAt: now + ttlMs })
}

export function readPendingWhatsAppQr(connectionId: string, now = Date.now()): string | null {
    sweepExpired(now)
    return pendingQrs.get(connectionId)?.dataUrl ?? null
}

export function clearPendingWhatsAppQr(connectionId: string, instanceId?: string): void {
    const pending = pendingQrs.get(connectionId)
    if (!pending) return
    if (instanceId !== undefined && pending.instanceId !== instanceId) return
    pendingQrs.delete(connectionId)
}

export function clearAllPendingWhatsAppQrsForTests(): void {
    pendingQrs.clear()
}
