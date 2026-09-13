'use server'

import { revalidatePath } from 'next/cache'
import {
  GET_AI_INTERN_STATE_RESULT_V1,
  SET_AI_INTERN_STATE_RESULT_V1,
  type GetAiInternStateQueryV1,
  type SetAiInternStateCommandV1,
} from '../../../contracts/calling/v1'
import {
  IntegrationAdminAuthorizationError,
  requireIntegrationAdminAccess,
} from '../../identity-access/public/v1'
import { createAiInternControlHandlerV1 } from '../public/v1/ai-intern-control-handler'
import { legacyPrismaAiInternControlPortV1 } from '../public/v1/legacy-prisma-ai-intern-control-adapter'

const aiInternControl = createAiInternControlHandlerV1(legacyPrismaAiInternControlPortV1)

/** State unknown to this caller. Already the contract's value for an unreadable state. */
const UNKNOWN_INTERN_STATE = { contract: GET_AI_INTERN_STATE_RESULT_V1, internEnabled: null } as const

/** Nothing was written. Already the contract's value for a write that did not happen. */
const NOT_SAVED = { contract: SET_AI_INTERN_STATE_RESULT_V1, saved: false } as const

/**
 * Read the AI intern toggle state.
 *
 * The authorization boundary is unchanged: `requireIntegrationAdminAccess`
 * still runs, still refuses a caller without the signed integration-admin
 * session, and still writes its denial to the server log. What changed is only
 * what a refused READ looks like on the wire.
 *
 * It used to escape as an unhandled rejection, so every messenger page load
 * without that session produced an HTTP 500. `ChatList` renders
 * `AiInternToggle`, which reads this on mount, so the 500 fired for ordinary
 * operators on both the desktop and the mobile lane — a server error on a
 * perfectly normal page. A browser happened to survive it because the caller
 * has a `.catch`, but a 500 per page load is not a boundary, it is noise that
 * hides real failures.
 *
 * A refused read now returns the same unknown state the contract already
 * defines for a state that cannot be read, which is what every other read
 * failure here has always returned. The caller learns nothing it did not
 * already know from being refused, and nothing is read once refused.
 */
export async function getAiInternStateV1(query: GetAiInternStateQueryV1 | unknown) {
  try {
    await requireIntegrationAdminAccess()
  } catch (error) {
    if (error instanceof IntegrationAdminAuthorizationError) return UNKNOWN_INTERN_STATE
    throw error
  }
  try { return await aiInternControl.getState(query) }
  catch { return UNKNOWN_INTERN_STATE }
}

/**
 * Write the AI intern toggle state.
 *
 * The refusal is unchanged in substance — the guard runs first, nothing is
 * written, and the denial is logged — but it is reported as the contract's own
 * `saved: false` rather than as a thrown error, because a thrown Server Action
 * is an HTTP 500 and a refused write is not a server fault. The caller is told
 * the write did not happen, which is the truth and is all it may know.
 *
 * The toggle in the messenger header already reverts its optimistic flip
 * whenever the save does not succeed, so what an operator sees is the same as
 * before: the switch springs back.
 */
export async function setAiInternStateV1(command: SetAiInternStateCommandV1 | unknown) {
  try {
    await requireIntegrationAdminAccess()
  } catch (error) {
    if (error instanceof IntegrationAdminAuthorizationError) return NOT_SAVED
    throw error
  }
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
