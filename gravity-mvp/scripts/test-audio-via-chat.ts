import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { createCallingOpenAiChatCompletionV1 } from '../src/modules/calling/public/v1/openai-chat-completion'
import { getObject } from '../src/lib/storage/minio'

/**
 * Proof-of-concept: transcribe a call recording via gpt-4o-audio-preview
 * through the /v1/chat/completions endpoint, bypassing the IP-blocked
 * /v1/audio/transcriptions endpoint. Chat endpoint works through our VPN
 * exit while Whisper endpoint does not.
 */
async function main() {
    const objectKey = process.argv[2] ?? '2026/05/d15bad52-04fa-498a-b3a0-eda047958e28.mp3'
    const mp3 = await getObject(objectKey)
    const audioBase64 = mp3.toString('base64')
    console.log('mp3_size=', mp3.length, 'base64_size=', audioBase64.length)

    const t0 = Date.now()
    try {
        const completion = await createCallingOpenAiChatCompletionV1({
            model: 'gpt-4o-audio-preview',
            modalities: ['text'],
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Это запись телефонного звонка на русском языке. Расшифруй её дословно. Верни только текст разговора без вступлений и комментариев.' },
                    { type: 'input_audio', input_audio: { data: audioBase64, format: 'mp3' } as any },
                ] as any,
            }],
        })
        console.log('STATUS: ok in', Date.now() - t0, 'ms')
        console.log('USAGE:', JSON.stringify(completion.usage))
        console.log('---TRANSCRIPT---')
        console.log(completion.choices[0].message.content)
    } catch (e: any) {
        console.log('FAILED status=', e.status, 'code=', e.code)
        console.log('cf-ray=', e.headers?.['cf-ray'])
        console.log('error=', JSON.stringify(e.error))
        process.exit(1)
    }
}

main()
