'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export interface TriggerItem {
    id: string
    name: string
    condition: string
    threshold: number
    action: string
    messageTemplate: string | null
    channel: string
    isActive: boolean
    createdAt: string
}

export async function getTriggers(): Promise<TriggerItem[]> {
    const triggers = await prisma.communicationTrigger.findMany({
        orderBy: { createdAt: 'desc' },
    })
    return triggers.map(t => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
    }))
}

export async function createTrigger(data: {
    name: string
    condition: string
    threshold: number
    action: string
    messageTemplate?: string
    channel: string
}) {
    await prisma.communicationTrigger.create({ data })
    revalidatePath('/settings/triggers')
}

export async function updateTrigger(id: string, data: Partial<{
    name: string
    condition: string
    threshold: number
    action: string
    messageTemplate: string
    channel: string
    isActive: boolean
}>) {
    await prisma.communicationTrigger.update({
        where: { id },
        data,
    })
    revalidatePath('/settings/triggers')
}

export async function deleteTrigger(id: string) {
    await prisma.communicationTrigger.delete({ where: { id } })
    revalidatePath('/settings/triggers')
}

export async function toggleTrigger(id: string, isActive: boolean) {
    await prisma.communicationTrigger.update({
        where: { id },
        data: { isActive },
    })
    revalidatePath('/settings/triggers')
}
