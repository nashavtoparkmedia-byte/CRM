'use server'

import type {
    GetAiInternStateQueryV1,
    SetAiInternStateCommandV1,
} from '../../../../contracts/calling/v1'
import {
    getAiInternStateV1 as executeGetAiInternStateV1,
    setAiInternStateV1 as executeSetAiInternStateV1,
} from '../../application/ai-intern-control-operations'

// These concrete async wrappers are the public Server Action boundary. Next.js
// does not register a re-export from a `use server` module as a Server Action,
// and callers must never reach the application implementation directly.
export async function getAiInternStateV1(query: GetAiInternStateQueryV1 | unknown) {
    return await executeGetAiInternStateV1(query)
}

export async function setAiInternStateV1(command: SetAiInternStateCommandV1 | unknown) {
    return await executeSetAiInternStateV1(command)
}
