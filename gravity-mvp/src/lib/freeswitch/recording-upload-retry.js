// Retry-with-backoff for ONE specific operation: uploading a finished
// MP3 recording to MinIO / S3. Deliberately not a generic retry
// framework — the policy here is hardcoded, audited at PR review,
// frozen at ship. Mirrors the «one function, one job, one set of
// constants» shape of bridge `retry-helpers.js` (PR #52).
//
// Why this exists
// ───────────────
// Before this helper, a transient MinIO blip at hangup-time (network
// hiccup, server restart, mid-flight TCP reset) would crash the
// upload exactly once and leave the recording lost forever. The WAV
// stays on disk (recordingProcessor.ts keeps it for manual recovery),
// but `Call.recordingPath` stays null and the operator never sees the
// audio in the CRM UI. Three short retries close ~95% of those
// incidents — anything beyond is a real outage, the WAV remains on
// disk, and the operator can replay the upload manually.
//
// Policy (FIXED, not configurable in production)
// ──────────────────────────────────────────────
//   attempt | per-attempt timeout         | backoff to next
//      1    | UPLOAD_TIMEOUT_MS (caller)  |     2000 ms
//      2    | UPLOAD_TIMEOUT_MS (caller)  |     5000 ms
//      3    | UPLOAD_TIMEOUT_MS (caller)  |       —
//
//   Retried errors (transient):
//     • Network errors (ECONNREFUSED / ECONNRESET / ETIMEDOUT / EAI_AGAIN)
//     • Caller-side timeout (matches /timeout_/ in error message;
//       recordingProcessor wraps each attempt in `withTimeout`)
//     • S3 5xx (server temporarily unhealthy)
//
//   NOT retried (caller-error / bug — retry doesn't help):
//     • S3 4xx (Forbidden / NoSuchBucket / InvalidAccessKey)
//     • ENOENT (local MP3 missing — encode stage bug)
//     • Anything else (conservative: unknown → don't retry, surface the bug)
//
// Out of scope
// ────────────
// This helper is ONLY for recording upload. It does NOT retry encode,
// transcribe-enqueue, presigned-URL generation, or any other recording
// pipeline stage. The narrowly-scoped helper pattern is intentional
// per the architect's «no generic retry framework» constraint.

'use strict'

// Hardcoded production policy. The `_createRetryUploadRecording`
// factory below exists ONLY so unit tests can shrink the backoffs to
// keep the suite runnable in milliseconds; production uses the frozen
// object below.
const PRODUCTION_POLICY = Object.freeze({
    ATTEMPTS: 3,
    BACKOFFS_MS: Object.freeze([2000, 5000]),  // before attempt 2, 3
})

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Decide whether an error indicates a transient condition worth
 * retrying. Conservative: only well-understood transient cases say
 * yes; anything unknown returns false so a real bug doesn't get
 * swallowed in three identical failures.
 */
function classifyError(err) {
    if (!err) return { retryable: false, category: 'unknown' }

    // Local file missing — bug in the encode stage, retry can't fix it.
    const code = err.code ?? err.cause?.code
    if (code === 'ENOENT') {
        return { retryable: false, category: 'enoent' }
    }

    // Node network error codes.
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET'
        || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
        return { retryable: true, category: 'network' }
    }

    // recordingProcessor.ts wraps each attempt in `withTimeout`, which
    // throws Error(`timeout_uploadFile_after_<ms>ms`) on the per-attempt
    // timeout. Treat that as transient.
    if (err.name === 'AbortError' || /timeout_/.test(err.message ?? '')) {
        return { retryable: true, category: 'timeout' }
    }

    // S3 SDK error metadata. The AWS SDK v3 puts the HTTP status on
    // `err.$metadata.httpStatusCode`; the legacy SDK uses
    // `err.statusCode`. Support both, defensively.
    const status = err.$metadata?.httpStatusCode ?? err.statusCode
    if (typeof status === 'number') {
        if (status >= 500 && status < 600) return { retryable: true, category: 's3_5xx' }
        if (status >= 400 && status < 500) return { retryable: false, category: 's3_4xx' }
    }

    // Default: don't retry. A bug that throws an unknown error class
    // is better surfaced once than masked behind three identical
    // retries.
    return { retryable: false, category: 'unknown' }
}

/**
 * Factory wrapping a policy. Production calls this once with the
 * frozen PRODUCTION_POLICY; unit tests can pass a fast policy
 * (BACKOFFS_MS=[1,2]) for ms-grained test runs.
 *
 * Returned function:
 *   retryUploadRecording({ uploadFn, callId, opsLog })
 *     → { ok: true, attempts: 1|2|3, totalMs }   on success
 *     → throws Error                              on final failure
 *
 *   `uploadFn` is a zero-arg async function the caller has already
 *   wrapped in `withTimeout` per attempt. The helper itself doesn't
 *   know about timeouts — it only retries.
 *
 *   `opsLog` is dependency-injected (signature `(level, event, ctx) => void`).
 *   Caller passes `@/infrastructure/operations/operational-log`. Tests pass a capturing mock. The
 *   helper file deliberately doesn't import opsLog at module scope
 *   so it stays a pure CommonJS module that `node --test` can
 *   require without a TS loader.
 */
function _createRetryUploadRecording(policy) {
    return async function retryUploadRecording({ uploadFn, callId, opsLog }) {
        const log = opsLog ?? (() => {})
        const startedAt = Date.now()
        let lastError = null
        let lastCategory = 'unknown'

        for (let attempt = 1; attempt <= policy.ATTEMPTS; attempt++) {
            try {
                await uploadFn()
                log('info', 'recording_upload_succeeded', {
                    callId,
                    attempt,
                    totalMs: Date.now() - startedAt,
                })
                return { ok: true, attempts: attempt, totalMs: Date.now() - startedAt }
            } catch (err) {
                lastError = err
                const { retryable, category } = classifyError(err)
                lastCategory = category

                if (!retryable) {
                    // Non-transient failure — surface immediately so
                    // the bug is visible, not masked by retries.
                    // staleRecordingOnDiskExpected=false because the
                    // typical non-retryable cases (4xx auth/bucket
                    // errors, ENOENT) need operator attention, not
                    // automatic eventual repair.
                    log('error', 'recording_upload_failed', {
                        callId,
                        attempt,
                        retryable: false,
                        category,
                        error: err.message ?? String(err),
                        staleRecordingOnDiskExpected: false,
                    })
                    throw err
                }

                if (attempt < policy.ATTEMPTS) {
                    log('warn', 'recording_upload_retry', {
                        callId,
                        attempt,
                        retryable: true,
                        category,
                        error: err.message ?? String(err),
                    })
                    await sleep(policy.BACKOFFS_MS[attempt - 1])
                    continue
                }
                // Last attempt failed — fall through to exhaustion log.
                break
            }
        }

        // All attempts exhausted on transient failures. The WAV is
        // still on disk (recordingProcessor doesn't delete it on
        // failure), so an operator CAN replay the upload manually.
        // staleRecordingOnDiskExpected=true flags this for runbook.
        log('error', 'recording_upload_failed', {
            callId,
            attempt: policy.ATTEMPTS,
            retryable: true,
            category: lastCategory,
            error: lastError?.message ?? 'unknown',
            staleRecordingOnDiskExpected: true,
        })
        throw lastError ?? new Error('upload failed after retry exhaustion')
    }
}

// Production singleton — what recordingProcessor.ts imports.
const retryUploadRecording = _createRetryUploadRecording(PRODUCTION_POLICY)

module.exports = {
    retryUploadRecording,
    // Test seam — keeps the suite fast. NOT for production code.
    _createRetryUploadRecording,
    PRODUCTION_POLICY,
    // Exported so tests can assert the classifier independently.
    classifyError,
}
