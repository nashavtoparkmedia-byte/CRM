'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { CREATE_COMMUNICATION_TRIGGER_COMMAND_V1, DELETE_COMMUNICATION_TRIGGER_COMMAND_V1, UPDATE_COMMUNICATION_TRIGGER_COMMAND_V1 } from '@/contracts/messaging/v1'
import { createCommunicationTriggerV1, deleteCommunicationTriggerV1, updateCommunicationTriggerV1 } from '@/modules/messaging/public/v1'

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
    await createCommunicationTriggerV1({ contract: CREATE_COMMUNICATION_TRIGGER_COMMAND_V1, data })
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
    await updateCommunicationTriggerV1({ contract: UPDATE_COMMUNICATION_TRIGGER_COMMAND_V1, triggerId: id, patch: data })
    revalidatePath('/settings/triggers')
}

export async function deleteTrigger(id: string) {
    await deleteCommunicationTriggerV1({ contract: DELETE_COMMUNICATION_TRIGGER_COMMAND_V1, triggerId: id })
    revalidatePath('/settings/triggers')
}

export async function toggleTrigger(id: string, isActive: boolean) {
    await updateCommunicationTriggerV1({ contract: UPDATE_COMMUNICATION_TRIGGER_COMMAND_V1, triggerId: id, patch: { isActive } })
    revalidatePath('/settings/triggers')
}
