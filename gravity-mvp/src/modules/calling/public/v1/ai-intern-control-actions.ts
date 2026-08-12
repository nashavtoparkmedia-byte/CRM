'use server'

import { revalidatePath } from 'next/cache'
import {
    GET_AI_INTERN_STATE_RESULT_V1,
    type GetAiInternStateQueryV1,
    type SetAiInternStateCommandV1,
} from '../../../../contracts/calling/v1'
import { requireIntegrationAdminAccess } from '../../../identity-access/public/v1'
import { createAiInternControlHandlerV1 } from './ai-intern-control-handler'
import { legacyPrismaAiInternControlPortV1 } from './legacy-prisma-ai-intern-control-adapter'

const aiInternControl = createAiInternControlHandlerV1(legacyPrismaAiInternControlPortV1)

export async function getAiInternStateV1(query: GetAiInternStateQueryV1 | unknown) {
    await requireIntegrationAdminAccess()
    try {
        return await aiInternControl.getState(query)
    } catch {
        return { contract: GET_AI_INTERN_STATE_RESULT_V1, internEnabled: null }
    }
}

export async function setAiInternStateV1(command: SetAiInternStateCommandV1 | unknown) {
    await requireIntegrationAdminAccess()
    try {
        const result = await aiInternControl.setState(command)
        revalidatePath('/settings/ai')
        return result
    } catch (error: any) {
        const detail = error?.message ?? 'unknown error'
        console.error('[AI Config] saveAiConfig error:', detail)
        throw new Error(`Не удалось сохранить настройки AI: ${detail}`)
    }
}
