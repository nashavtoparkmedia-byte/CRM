import {
    EslOriginateOutcomeUnknownError,
    EslOriginateRejectedError,
    originateAiCall,
} from '@/lib/ai-call/esl-originate'
import {
    ControlledRealAiCallDispatchError,
    type ControlledRealAiCallProviderPort,
} from '../../application/controlled-real-ai-call-provider'
import { controlledRealCallHardLimit } from '../../application/controlled-real-ai-call'

export const freeswitchControlledRealAiCallProvider: ControlledRealAiCallProviderPort = {
    provider: 'freeswitch',
    async dispatch({ fsUuid, toNumber, configuration }) {
        const dialString = configuration.dialStringTemplate.replace(
            '${number}',
            toNumber.slice(1),
        )
        const recordingPath = `/var/lib/freeswitch/recordings/${fsUuid}.wav`
        try {
            await originateAiCall({
                connection: configuration.esl,
                fsUuid,
                dialString,
                extension: configuration.parkExtension,
                callerIdName: 'AI Assistant',
                vars: controlledRealAiCallChannelVars(recordingPath),
            })
            return { providerReference: fsUuid }
        } catch (error) {
            if (error instanceof EslOriginateOutcomeUnknownError) {
                throw new ControlledRealAiCallDispatchError('outcome_unknown')
            }
            if (error instanceof EslOriginateRejectedError) {
                throw new ControlledRealAiCallDispatchError('rejected')
            }
            throw new ControlledRealAiCallDispatchError('unavailable')
        }
    },
}

/**
 * The channel variables one controlled real AI call is dialed with.
 *
 * Both safety layers are installed here, before the number is dialed, which is the
 * whole point: a hook that is only attached after the bridge observes the answer is
 * missing exactly when the bridge or its event socket is already unavailable, and a
 * deaf call is still a live billable call.
 *
 *   execute_on_answer                     recording (unchanged)
 *   execute_on_answer_yoko_ai_hard_limit  FreeSWITCH's own physical backstop
 *   yoko_ai_max_answered_ms               the same policy, for the bridge to read
 *
 * FreeSWITCH executes every channel variable whose name starts with
 * `execute_on_answer`, so the hard-limit hook has its own suffixed name and the
 * recording hook keeps the bare one — verified on the pinned 1.10.12 build, where
 * both ran on one channel. `sched_hangup` is scheduled by the FreeSWITCH core at
 * the answer instant, so it survives the bridge, the event socket and the network
 * going away afterwards.
 *
 * Values must contain no comma: the originate command joins variables with commas.
 * Spaces are fine inside the single quotes, exactly as the recording hook already
 * relies on.
 */
export function controlledRealAiCallChannelVars(recordingPath: string): Record<string, string> {
    const limit = controlledRealCallHardLimit()
    return {
        RECORD_STEREO: 'true',
        recording_follow_transfer: 'true',
        recording_file: recordingPath,
        execute_on_answer: `'record_session ${recordingPath}'`,
        execute_on_answer_yoko_ai_hard_limit: `'sched_hangup +${limit.seconds} NORMAL_CLEARING'`,
        yoko_ai_max_answered_ms: String(limit.maxAnsweredMs),
    }
}
