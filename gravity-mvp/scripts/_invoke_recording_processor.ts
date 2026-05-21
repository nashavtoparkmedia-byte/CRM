/* eslint-disable */
// Internal — invoked by smoke_ai_persistence.js via `npx tsx <file>`. Direct
// process invocation of recordingProcessor.processRecording from outside
// the Next.js runtime, so the smoke doesn't have to wait for a real ESL
// CHANNEL_HANGUP_COMPLETE event.
//
// Usage: tsx _invoke_recording_processor.ts <callId> <fsUuid> <recordingFile>

import { processRecording } from '@/lib/freeswitch/recordingProcessor'

async function main() {
    const [, , callId, fsUuid, recordingFile] = process.argv
    if (!callId || !fsUuid || !recordingFile) {
        console.error('usage: tsx _invoke_recording_processor.ts <callId> <fsUuid> <recordingFile>')
        process.exit(1)
    }
    await processRecording({ callId, fsUuid, recordingFile })
    process.exit(0)
}

main().catch(err => {
    console.error('FATAL:', err.message)
    process.exit(2)
})
