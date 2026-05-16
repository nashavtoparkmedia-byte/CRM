/**
 * Yandex SpeechKit STT v3 streaming gRPC adapter.
 *
 * Streams binary PCM (LINEAR16, 8 kHz mono) into Yandex SpeechKit and emits
 * partial / final transcripts via callbacks. No buffering, no retries — chunks
 * forwarded as they arrive from mod_audio_fork.
 *
 * Env required to enable:
 *   YANDEX_API_KEY   — service-account static API key (AQVN...)
 *   YANDEX_FOLDER_ID — optional, logged for context only
 *
 * Lang: ru-RU. To change, set YANDEX_STT_LANG.
 */

const { Session } = require('@yandex-cloud/nodejs-sdk')
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
        this.stream = null
        this.started = false
        this.chunkCount = 0
    }

    async start() {
        if (this.started) return
        this.started = true

        const session = new Session({ apiKey: this.apiKey })
        const client = session.client(RecognizerClient)

        const sessionOptions = {
            recognitionModel: {
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

        try {
            this.stream = client.recognizeStreaming()
        } catch (err) {
            this.started = false
            throw new Error(`recognizeStreaming() init failed: ${err.message}`)
        }

        this.stream.on('data', resp => this._handleResponse(resp))
        this.stream.on('error', err => {
            this.onError(err)
            this.started = false
        })
        this.stream.on('end', () => {
            console.log(`[stt] stream end (sent ${this.chunkCount} chunks)`)
            this.started = false
        })

        // First message must carry session options
        this.stream.write({ sessionOptions })
        console.log(
            `[stt] streaming started — lang=${LANG}, rate=${SAMPLE_RATE}Hz, folder=${this.folderId ?? '-'}`,
        )
    }

    /** Feed raw PCM bytes. */
    send(pcmBuffer) {
        if (!this.started || !this.stream) return
        this.chunkCount++
        try {
            this.stream.write({ chunk: { data: pcmBuffer } })
        } catch (err) {
            console.error(`[stt] write error: ${err.message}`)
        }
    }

    stop() {
        if (this.stream) {
            try { this.stream.end() } catch {}
            this.stream = null
        }
        this.started = false
    }

    _handleResponse(resp) {
        // Yandex returns a `StreamingResponse` with a oneof event field.
        // After protobuf decode, only the present branch is populated.
        if (resp.partial?.alternatives?.length) {
            const a = resp.partial.alternatives[0]
            this.onPartial(a.text ?? '', a.confidence ?? 0)
        } else if (resp.final?.alternatives?.length) {
            const a = resp.final.alternatives[0]
            this.onFinal(a.text ?? '')
        } else if (resp.finalRefinement?.normalizedText?.alternatives?.length) {
            const a = resp.finalRefinement.normalizedText.alternatives[0]
            this.onFinal(`[normalized] ${a.text ?? ''}`)
        }
    }
}

module.exports = { YandexSttSession, SAMPLE_RATE, LANG }
