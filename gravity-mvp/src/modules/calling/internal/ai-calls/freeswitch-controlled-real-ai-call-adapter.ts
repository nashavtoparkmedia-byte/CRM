import {
    EslOriginateOutcomeUnknownError,
    EslOriginateRejectedError,
    originateAiCall,
} from '@/lib/ai-call/esl-originate'
import {
    ControlledRealAiCallDispatchError,
    type ControlledRealAiCallProviderPort,
} from '../../application/controlled-real-ai-call-provider'

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
                vars: {
                    RECORD_STEREO: 'true',
                    recording_follow_transfer: 'true',
                    recording_file: recordingPath,
                    execute_on_answer: `'record_session ${recordingPath}'`,
                },
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
