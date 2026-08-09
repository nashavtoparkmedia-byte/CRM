'use server'

import { logManagerCall as legacyLogManagerCall } from '@/app/drivers/actions'
import type { LogManagerCallCommandV1, LogManagerCallResultV1 } from '../../../../contracts/fleet-operations/v1'
import { createLogManagerCallHandlerV1 } from './log-manager-call-handler'

const logManagerCall = createLogManagerCallHandlerV1({ logManagerCall: legacyLogManagerCall })

/** Versioned compatibility action; legacy persistence is migrated separately. */
export async function logManagerCallV1(
    command: LogManagerCallCommandV1 | unknown,
): Promise<LogManagerCallResultV1> {
    return logManagerCall(command)
}
