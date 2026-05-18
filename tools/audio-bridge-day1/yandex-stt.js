/**
 * Yandex SpeechKit STT v3 streaming adapter.
 *
 * Streams binary PCM (LINEAR16, 8 kHz mono) into Yandex SpeechKit and emits
 * partial / final transcripts via callbacks. No buffering, no retries — chunks
 * forwarded as they arrive from mod_audio_fork.
 *
 * Two non-obvious bits that were wrong in the previous implementation and
 * are now fixed:
 *
 *   1. Auth. SDK 3.2 `Session({apiKey: ...})` doesn't actually understand
 *      apiKey — it falls back to MetadataTokenService which tries to
 *      reach 169.254.169.254 (Yandex Cloud VM metadata) and hangs forever
 *      outside a VM. Yandex SpeechKit v3 accepts a static API key
 *      directly through the gRPC `authorization: Api-Key <key>` metadata
 *      header. We build the channel manually around that.
 *
 *   2. Transport. SDK 3.2 wraps gRPC clients with nice-grpc, whose bidi
 *      streaming returns an AsyncIterable<Response> and takes an
 *      AsyncIterable<Request> — NOT a Node Duplex stream with
 *      .on('data')/.write(). The previous code crashed with
 *      `this.stream.on is not a function` for exactly this reason.
 *      We use a small PushableAsyncIterable adapter so the rest of the
 *      bridge can keep its imperative `send(pcm)` API.
 *
 * Env required to enable:
 *   YANDEX_API_KEY   — service-account static API key (AQVN...)
 *   YANDEX_FOLDER_ID — optional, logged for context only
 *
 * Lang: ru-RU. To change, set YANDEX_STT_LANG.
 */

const { credentials, Metadata } = require('@grpc/grpc-js')
const { createChannel, createClientFactory } = require('nice-grpc')
const {
    RecognizerClient,
} = require('@yandex-cloud/nodejs-sdk/dist/generated/yandex/cloud/ai/stt/v3/stt_service')
const {
    RawAudio_AudioEncoding,
    TextNormalizationOptions_TextNormalization,
    LanguageRestrictionOptions_LanguageRestrictionType,
    RecognitionModelOptions_AudioProcessingType,
} = require('@yandex-cloud/nodejs-sdk/dist/generated/yandex/cloud/ai/stt/v3/stt')

const LANG = (process.env.YANDEX_STT_LANG ?? 'ru-RU').trim()
const SAMPLE_RATE = 8000
// Required by proto — undefined here crashes serialization. Valid values
// per Yandex docs: 'general' | 'general:rc' | 'general:deprecated'.
const MODEL = (process.env.YANDEX_STT_MODEL ?? 'general').trim()
const ENDPOINT = process.env.YANDEX_STT_ENDPOINT ?? 'stt.api.cloud.yandex.net:443'

/**
 * Pushable async iterable — nice-grpc bidi streaming wants AsyncIterable
 * as the request channel, but PCM chunks arrive from the outside (the
 * bridge calls `send(buf)` synchronously when frames land on the WS).
 * Standard `async function*` generators can't be pushed-to externally,
 * so this small queue+waiter adapter bridges the gap.
 */
class PushableAsyncIterable {
    constructor() {
        this.queue = []
        this.waiters = []
        this.done = false
    }
    push(item) {
        if (this.done) return
        if (this.waiters.length > 0) {
            this.waiters.shift()({ value: item, done: false })
        } else {
            this.queue.push(item)
        }
    }
    end() {
        this.done = true
        while (this.waiters.length > 0) {
            this.waiters.shift()({ value: undefined, done: true })
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => new Promise(resolve => {
                if (this.queue.length > 0) {
                    resolve({ value: this.queue.shift(), done: false })
                } else if (this.done) {
                    resolve({ value: undefined, done: true })
                } else {
                    this.waiters.push(resolve)
                }
            }),
        }
    }
}

/**
 * Build a RecognizerClient that authenticates with a static API key.
 * We bypass `Session` from the SDK because it doesn't actually handle
 * apiKey configs — see the file header.
 */
function buildRecognizerClient(apiKey) {
    const callCreds = credentials.createFromMetadataGenerator((_params, cb) => {
        const md = new Metadata()
        md.set('authorization', `Api-Key ${apiKey}`)
        cb(null, md)
    })
    const channelCreds = credentials.combineChannelCredentials(credentials.createSsl(), callCreds)
    const channel = createChannel(ENDPOINT, channelCreds)
    return createClientFactory().create(RecognizerClient.service, channel)
}

class YandexSttSession {
    /**
     * @param {object} opts
     * @param {string} opts.apiKey
     * @param {string} [opts.folderId]
     * @param {(text: string, confidence: number) => void} [opts.onPartial]
     * @param {(text: string) => void} [opts.onFinal]
     * @param {(err: Error) => void} [opts.onError]
     */
    constructor(opts) {
        this.apiKey = opts.apiKey
        this.folderId = opts.folderId
        this.onPartial = opts.onPartial ?? (() => {})
        this.onFinal = opts.onFinal ?? (() => {})
        this.onError = opts.onError ?? (err => console.error(`[stt] error: ${err.message}`))
        this.requests = null    // PushableAsyncIterable<StreamingRequest>
        this.consumeP = null    // Promise resolving when response stream ends
        this.started = false
        this.chunkCount = 0
    }

    async start() {
        if (this.started) return
        this.started = true

        const client = buildRecognizerClient(this.apiKey)

        const sessionOptions = {
            recognitionModel: {
                model: MODEL,
                audioFormat: {
                    rawAudio: {
                        audioEncoding: RawAudio_AudioEncoding.LINEAR16_PCM,
                        sampleRateHertz: SAMPLE_RATE,
                        audioChannelCount: 1,
                    },
                },
                textNormalization: {
                    textNormalization:
                        TextNormalizationOptions_TextNormalization.TEXT_NORMALIZATION_ENABLED,
                    profanityFilter: false,
                    literatureText: false,
                },
                languageRestriction: {
                    restrictionType:
                        LanguageRestrictionOptions_LanguageRestrictionType.WHITELIST,
                    languageCode: [LANG],
                },
                audioProcessingType:
                    RecognitionModelOptions_AudioProcessingType.REAL_TIME,
            },
        }

        this.requests = new PushableAsyncIterable()
        // First message must carry session options before any audio chunk.
        this.requests.push({ sessionOptions })

        let responses
        try {
            responses = client.recognizeStreaming(this.requests)
        } catch (err) {
            this.started = false
            throw new Error(`recognizeStreaming() init failed: ${err.message}`)
        }

        console.log(
            `[stt] streaming started — model=${MODEL}, lang=${LANG}, rate=${SAMPLE_RATE}Hz, folder=${this.folderId ?? '-'}`,
        )

        // Consume responses in the background. Errors surface via onError
        // and through stop() resolving.
        this.consumeP = (async () => {
            try {
                for await (const resp of responses) {
                    this._handleResponse(resp)
                }
                console.log(`[stt] stream end (sent ${this.chunkCount} chunks)`)
            } catch (err) {
                if (this.started) this.onError(err)
            } finally {
                this.started = false
            }
        })()
    }

    /** Feed raw PCM bytes. */
    send(pcmBuffer) {
        if (!this.started || !this.requests) return
        this.chunkCount++
        try {
            this.requests.push({ chunk: { data: pcmBuffer } })
        } catch (err) {
            console.error(`[stt] write error: ${err.message}`)
        }
    }

    stop() {
        if (this.requests) {
            try { this.requests.end() } catch {}
            this.requests = null
        }
        this.started = false
    }

    _handleResponse(resp) {
        // Yandex returns a `StreamingResponse` with a oneof event field
        // plus top-level diagnostic fields (responseWallTimeMs, audioCursors,
        // sessionUuid). Speech text lives under `partial.alternatives[].text`
        // for streaming partials, `final.alternatives[].text` for the
        // utterance final, and `finalRefinement.normalizedText.alternatives[].text`
        // for the post-normalisation refinement.
        if (resp.partial?.alternatives?.length) {
            const a = resp.partial.alternatives[0]
            const text = a.text ?? ''
            if (text) this.onPartial(text, a.confidence ?? 0)
        } else if (resp.final?.alternatives?.length) {
            const a = resp.final.alternatives[0]
            const text = a.text ?? ''
            if (text) this.onFinal(text)
        } else if (resp.finalRefinement?.normalizedText?.alternatives?.length) {
            const a = resp.finalRefinement.normalizedText.alternatives[0]
            const text = a.text ?? ''
            // Refinement supersedes the final — prefer this when it arrives.
            if (text) this.onFinal(text)
        }
        // Other events (statusCode, eouUpdate, plain partial without
        // alternatives) are diagnostic — ignored on the orchestrator side.
    }
}

module.exports = { YandexSttSession, SAMPLE_RATE, LANG, MODEL }
