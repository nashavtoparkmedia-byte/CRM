import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { existsSync } from 'fs'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { prisma } from '@/lib/prisma'
import {
    backfillCompletedCallTimelineV1,
    enqueueRecoveredCallTranscriptionV1,
    recoverCallRecordingV1,
} from '@/modules/calling/public/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'

export const runtime = 'nodejs'

/**
 * POST /api/admin/reprocess-recordings
 *
 * Ad-hoc recovery for the call-processing pipeline. Scans Call rows that
 * were answered but have no transcript yet, and re-runs whichever pipeline
 * stage is missing.
 *
 * Per Call:
 *   - has transcript                 → skip
 *   - has recordingPath, no transcript → enqueueTranscribe (most common case
 *                                         when enqueue silently failed live)
 *   - no recordingPath, WAV on disk  → full processRecording
 *                                         (WAV→MP3→MinIO→Call→enqueue)
 *   - no recordingPath, no WAV       → skip (call wasn't recorded — usually
 *                                         a rejected or cancelled originate)
 *
 * Optional body `{ callId }` narrows to a single Call. Without it, the
 * scope is all calls answered within the last 30 days (avoid rescanning
 * historical journal entries on every retry).
 *
 * BullMQ does the actual work async — a 200 here means "jobs queued",
 * not "transcripts ready". Poll the Call rows or open the call detail
 * page for live progress via SSE.
 */
export async function POST(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const callIdFilter = typeof body?.callId === 'string' && body.callId.trim() ? body.callId.trim() : null

    const recordingsDir = process.env.RECORDINGS_HOST_PATH ?? path.resolve(process.cwd(), '..', 'telephony', 'recordings')

    const where: any = { transcript: null, status: 'completed' }
    if (callIdFilter) {
        where.id = callIdFilter
    } else {
        // Bound the historical scan — older than 30 days is almost certainly
        // either intentionally untranscribed or has lost its WAV by now.
        where.startedAt = { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
    }

    const calls = await prisma.call.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        select: {
            id: true, fsUuid: true, recordingPath: true, durationSec: true, hangupCause: true,
            // Extra fields needed by syncCallToChat:
            contactId: true, driverId: true, direction: true, fromNumber: true, toNumber: true,
            status: true, startedAt: true, endedAt: true,
        },
    })

    const results: Array<{ callId: string; fsUuid: string | null; action: string; reason?: string; error?: string }> = []
    let processed = 0
    let enqueued = 0
    let skipped = 0
    let errors = 0

    for (const call of calls) {
        try {
            // Backfill chat timeline regardless of recording state — even calls
            // with no recording (rejected, no_answer) should appear inline.
            await backfillCompletedCallTimelineV1(call).catch(err =>
                opsLog('warn', 'backfill_chat_sync_failed', { operation: 'call', callId: call.id, error: err.message })
            )

            if (call.recordingPath) {
                // MP3 already in MinIO — Stage 4 just never got the job for it.
                // Most common case after the silent enqueueTranscribe failure.
                await enqueueRecoveredCallTranscriptionV1(call.id)
                enqueued++
                results.push({ callId: call.id, fsUuid: call.fsUuid, action: 'transcribe_enqueued' })
                continue
            }

            // No recordingPath — see if a WAV is still on disk we can salvage.
            if (!call.fsUuid) {
                skipped++
                results.push({ callId: call.id, fsUuid: null, action: 'skip', reason: 'no_fsuuid_no_recording' })
                continue
            }
            const wavHostPath = path.join(recordingsDir, `${call.fsUuid}.wav`)
            if (!existsSync(wavHostPath)) {
                skipped++
                results.push({ callId: call.id, fsUuid: call.fsUuid, action: 'skip', reason: 'no_wav_on_disk' })
                continue
            }

            await recoverCallRecordingV1({
                callId: call.id,
                fsUuid: call.fsUuid,
                recordingFile: `/var/lib/freeswitch/recordings/${call.fsUuid}.wav`,
            })
            processed++
            results.push({ callId: call.id, fsUuid: call.fsUuid, action: 'reprocessed' })
        } catch (err: any) {
            errors++
            results.push({ callId: call.id, fsUuid: call.fsUuid, action: 'error', error: err.message })
            opsLog('error', 'reprocess_recording_failed', { operation: 'recording', callId: call.id, error: err.message })
        }
    }

    return NextResponse.json({
        ok: true,
        scanned: calls.length,
        filter: callIdFilter ?? '(last 30 days, status=completed, transcript=null)',
        summary: { processed, enqueued, skipped, errors },
        results,
    })
}
