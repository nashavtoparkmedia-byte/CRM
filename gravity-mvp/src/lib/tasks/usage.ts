'use server'

// ═══════════════════════════════════════════════════════════════════
// Usage telemetry — rollout observation layer for the churn list MVP.
//
// Contract:
//   • fire-and-forget: never throws to the caller
//   • raw SQL: Prisma Client generation may lag behind the schema
//   • no PII beyond userId (from cookie) and the action name
//   • payload is optional, small (<1KB), structured — never free text
// ═══════════════════════════════════════════════════════════════════

import { prisma } from '@/lib/prisma'

export async function recordUsage(
    action: string,
    payload?: Record<string, unknown>,
): Promise<void> {
    try {
        const { cookies } = await import('next/headers')
        const cookieStore = await cookies()
        const userId = cookieStore.get('crm_user_id')?.value ?? null

        const id =
            'u_' +
            Date.now().toString(36) +
            Math.random().toString(36).slice(2, 8)

        const payloadJson = payload ? JSON.stringify(payload) : null

        await prisma.$executeRaw`
            INSERT INTO usage_events (id, "userId", action, payload, "createdAt")
            VALUES (
                ${id},
                ${userId},
                ${action},
                ${payloadJson}::jsonb,
                NOW()
            )
        `
    } catch {
        // Telemetry must not break the app
    }
}
