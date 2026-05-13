/**
 * Post-processing for FreeSWITCH call recordings.
 *
 * Triggered by the ESL CHANNEL_HANGUP_COMPLETE handler:
 *   1. Read the WAV file FreeSWITCH wrote to the shared volume
 *   2. Re-encode to MP3 (stereo 64kbps — adequate for voice + transcription)
 *   3. Upload to S3/MinIO
 *   4. Update the Call row with recordingPath (object key)
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
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { uploadFile, S3_BUCKET } from '@/lib/storage/minio'

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

export async function processRecording(args: {
    callId: string
    fsUuid: string
    recordingFile: string | null
}): Promise<void> {
    if (!args.recordingFile) return

    const wavHostPath = translateToHostPath(args.recordingFile)

    // Give FreeSWITCH a moment to flush the file. record_session closes the
    // file synchronously on hangup, but on Windows Docker the bind mount can
    // lag a few hundred ms.
    if (!existsSync(wavHostPath)) {
        await sleep(500)
        if (!existsSync(wavHostPath)) {
            opsLog('warn', 'recording_wav_missing', { operation: 'recording', callId: args.callId, error: wavHostPath })
            return
        }
    }

    const mp3LocalPath = path.join(os.tmpdir(), `${args.fsUuid}.mp3`)
    const objectKey = `${new Date().getFullYear()}/${pad(new Date().getMonth() + 1)}/${args.fsUuid}.mp3`

    try {
        await encodeToMp3(wavHostPath, mp3LocalPath)
        await uploadFile(mp3LocalPath, objectKey, 'audio/mpeg')

        await prisma.call.update({
            where: { id: args.callId },
            data: { recordingPath: objectKey },
        })

        opsLog('info', 'recording_uploaded', {
            operation: 'recording',
            callId: args.callId,
            objectKey,
        })

        // Cleanup local copies. Best-effort — failure here is not fatal.
        await fs.unlink(wavHostPath).catch(() => {})
        await fs.unlink(mp3LocalPath).catch(() => {})
    } catch (err: any) {
        opsLog('error', 'recording_processing_failed', {
            operation: 'recording',
            callId: args.callId,
            error: err.message,
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
