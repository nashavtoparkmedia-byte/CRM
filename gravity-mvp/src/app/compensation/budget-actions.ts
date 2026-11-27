'use server'

import { revalidatePath } from 'next/cache'

import { ensureCompensationBudgetPeriodV1 } from '@/modules/fleet-operations/public/v1'

import { managerSession } from './manager-data'

/**
 * The CRM's one budget-management entry point.
 *
 * The monetary core remains the sole source of truth: this action only proves
 * the signed Staff Session and forwards the operator's month/limit to the
 * existing owner operation. That operation is monotonic (create or raise;
 * never lower or reopen), idempotent and concurrency-safe.
 */
export async function provisionCompensationBudget(formData: FormData): Promise<void> {
    const session = await managerSession()
    if (!session.ok) return

    const periodKey = String(formData.get('periodKey') ?? '')
    const rawRubles = String(formData.get('limitRubles') ?? '').trim().replace(',', '.')
    const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/u.exec(rawRubles)
    if (match === null) return

    const fraction = (match[2] ?? '').padEnd(2, '0')
    const limitKopecks = Number(match[1]) * 100 + Number(fraction || '0')
    if (!Number.isSafeInteger(limitKopecks) || limitKopecks <= 0) return

    await ensureCompensationBudgetPeriodV1({ periodKey, limitKopecks })
    revalidatePath('/compensation')
}
