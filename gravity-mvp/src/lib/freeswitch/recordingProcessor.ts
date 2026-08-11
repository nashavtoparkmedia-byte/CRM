/**
 * Post-processing for FreeSWITCH call recordings.
 *
 * Triggered by the ESL CHANNEL_HANGUP_COMPLETE handler:
 *   1. Read the WAV file FreeSWITCH wrote to the shared volume
 *   2. Re-encode to MP3 (stereo 64kbps — adequate for voice + transcription)
 *   3. Upload to S3/MinIO
 *   4. Atomically update Call.recordingPath and append RecordingReady.v1
 *      to the transactional outbox
 *   5. Best-effort cleanup of the local WAV
 *
 * Stage 4 (transcription) will read recordings directly from S3 by Call.recordingPath
 * — no need to keep the local copy around once uploaded.
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { uploadFile, S3_BUCKET } from '@/modules/calling/public/v1/recording-storage'
import { broadcastCall } from '@/lib/callStreamBus'
import { persistRecordingReadyV1 } from '@/modules/calling/public/v1'
// Plain CommonJS helper — pure retry policy for the MinIO upload, no
// generic abstraction. See `./recording-upload-retry.js` for the
// hardcoded policy (3 attempts, [2000, 5000] ms backoffs, transient-
// only). opsLog is dependency-injected to keep that helper require-
// able by `node --test` without a TS loader.
import { retryUploadRecording } from './recording-upload-retry'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

/**
 * Resolve the WAV path on the host. FreeSWITCH writes inside its container
 * to /var/lib/freeswitch/recordings/UUID.wav; we bind-mounted that directory
 * to RECORDINGS_HOST_PATH so it's the same file from this process's view.
 */
const RECORDINGS_HOST_PATH = process.env.RECORDINGS_HOST_PATH ?? path.resolve(process.cwd(), '..', 'telephony', 'recordings')
const CONTAINER_RECORDINGS_PREFIX = '/var/lib/freeswitch/recordings/'

function translateToHostPath(containerPath: string): string {
    if (containerPath.startsWith(CONTAINER_RECORDINGS_PREFIX)) {
        const fileName = containerPath.slice(CONTAINER_RECORDINGS_PREFIX.length)
        return path.join(RECORDINGS_HOST_PATH, fileName)
    }
    return containerPath
}

/**
 * Wrap a Promise with a deadline. If `p` doesn't settle in `ms`, throws
 * `timeout_<stage>_<ms>ms`. Lets us guarantee processRecording never
 * blocks the ESL event loop on a wedged MinIO / Redis / ffmpeg.
 */
function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
    let to: NodeJS.Timeout | undefined
    const timer = new Promise<never>((_, reject) => {
        to = setTimeout(() => reject(new Error(`timeout_${stage}_after_${ms}ms`)), ms)
    })
    return Promise.race([p, timer]).finally(() => { if (to) clearTimeout(to) }) as Promise<T>
}

const ENCODE_TIMEOUT_MS = Number(process.env.RECORDING_ENCODE_TIMEOUT_MS ?? 60_000)
const UPLOAD_TIMEOUT_MS = Number(process.env.RECORDING_UPLOAD_TIMEOUT_MS ?? 30_000)

export async function processRecording(args: {
    callId: string
    fsUuid: string
    recordingFile: string | null
}): Promise<void> {
    // Per-stage logging is the explicit fix for Task #4 — when something
    // (MinIO, ffmpeg, Redis) is down, recordingPath used to stay null with
    // a single «recording_processing_failed» line that didn't say which
    // stage broke. Now every stage either logs success or a tagged error,
    // so operators can see at a glance whether the WAV was found, encoded,
    // uploaded, persisted, and committed to the durable queue.
    if (!args.recordingFile) {
        opsLog('warn', 'recording_skipped_no_file', {
            operation: 'recording', callId: args.callId,
        })
        return
    }

    const startedAt = Date.now()
    const wavHostPath = translateToHostPath(args.recordingFile)

    // Give FreeSWITCH a moment to flush the file. record_session closes the
    // file synchronously on hangup, but on Windows Docker the bind mount can
    // lag a few hundred ms.
    if (!existsSync(wavHostPath)) {
        await sleep(500)
        if (!existsSync(wavHostPath)) {
            opsLog('warn', 'recording_wav_missing', {
                operation: 'recording', callId: args.callId, error: wavHostPath,
            })
            return
        }
    }

    const wavSize = await fs.stat(wavHostPath).then(s => s.size).catch(() => -1)
    opsLog('info', 'recording_stage_wav_found', {
        operation: 'recording', callId: args.callId,
        wavHostPath, wavSize,
    })

    const mp3LocalPath = path.join(os.tmpdir(), `${args.fsUuid}.mp3`)
    const objectKey = `${new Date().getFullYear()}/${pad(new Date().getMonth() + 1)}/${args.fsUuid}.mp3`

    try {
        const encStart = Date.now()
        await withTimeout(encodeToMp3(wavHostPath, mp3LocalPath), ENCODE_TIMEOUT_MS, 'encodeToMp3')
        const mp3Size = await fs.stat(mp3LocalPath).then(s => s.size).catch(() => -1)
        opsLog('info', 'recording_stage_encoded', {
            operation: 'recording', callId: args.callId,
            mp3Size, encodeMs: Date.now() - encStart,
        })

        const upStart = Date.now()
        // Retry-wrap the upload: each attempt keeps the existing
        // per-attempt timeout (UPLOAD_TIMEOUT_MS), the helper itself
        // adds bounded retries for transient errors only. WAV stays
        // on disk on final failure — see the existing «leave WAV in
        // place» comment in the outer catch.
        await retryUploadRecording({
            uploadFn: () => withTimeout(
                uploadFile(mp3LocalPath, objectKey, 'audio/mpeg'),
                UPLOAD_TIMEOUT_MS,
                'uploadFile',
            ),
            callId: args.callId,
            opsLog,
        })
        opsLog('info', 'recording_stage_uploaded', {
            operation: 'recording', callId: args.callId,
            objectKey, uploadMs: Date.now() - upStart,
        })

        const outboxEvent = await persistRecordingReadyV1({
            callId: args.callId,
            recordingPath: objectKey,
            correlationId: args.callId,
            causationId: args.fsUuid,
        })

        opsLog('info', 'recording_uploaded', {
            operation: 'recording',
            callId: args.callId,
            objectKey,
            outboxEventId: outboxEvent.eventId,
            totalMs: Date.now() - startedAt,
        })

        // Notify any open SSE listeners that the recording is ready to play.
        broadcastCall({
            type: 'updated',
            data: { callId: args.callId, recordingPath: objectKey },
        })

        // Stage 4 handoff is now durable: the Call.recordingPath update and
        // RecordingReady.v1 outbox event committed atomically above. A bounded
        // publisher retries Redis delivery and exposes poison rows as
        // dead_letter instead of losing the enqueue on a transient outage.
        opsLog('info', 'recording_stage_transcribe_outbox_committed', {
            operation: 'recording',
            callId: args.callId,
            outboxEventId: outboxEvent.eventId,
        })

        // Cleanup local copies. Best-effort — failure here is not fatal.
        await fs.unlink(wavHostPath).catch(() => {})
        await fs.unlink(mp3LocalPath).catch(() => {})
    } catch (err: any) {
        // Identify which stage tripped via the `timeout_<stage>_...` tag
        // emitted by withTimeout, OR via the original error message.
        const tag = /^timeout_([a-zA-Z]+)_/.exec(err.message)?.[1] ?? 'unknown'
        opsLog('error', 'recording_processing_failed', {
            operation: 'recording',
            callId: args.callId,
            stage: tag,
            error: err.message,
            totalMs: Date.now() - startedAt,
        })
        // Leave the WAV in place so we can retry / debug manually.
    }
}

function encodeToMp3(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .audioCodec('libmp3lame')
            .audioBitrate('64k')
            .audioChannels(2)
            .format('mp3')
            .on('end', () => resolve())
            .on('error', err => reject(err))
            .save(output)
    })
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
}

function pad(n: number): string {
    return n.toString().padStart(2, '0')
}

export { S3_BUCKET }
