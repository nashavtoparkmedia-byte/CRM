import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { ProxyAgent, fetch, FormData } from 'undici'
import { getObject } from '../src/lib/storage/minio'

/**
 * Bypass the OpenAI SDK entirely. Send a curl-equivalent POST with just
 * the bare Authorization header. If this returns 200 while the SDK returns
 * 403, the SDK's outgoing fingerprint (some non-strippable header or body
 * detail) is what triggers OpenAI's audio geo-block on our VPN exit.
 */
async function main() {
    const objectKey = process.argv[2] ?? '2026/05/d15bad52-04fa-498a-b3a0-eda047958e28.mp3'
    const mp3 = await getObject(objectKey)
    const proxy = process.env.HTTPS_PROXY || 'http://127.0.0.1:10809'
    const dispatcher = new ProxyAgent(proxy)

    const fd = new FormData()
    fd.set('file', new Blob([new Uint8Array(mp3)], { type: 'audio/mpeg' }), 'recording.mp3')
    fd.set('model', 'whisper-1')
    fd.set('language', 'ru')
    fd.set('response_format', 'text')

    const t0 = Date.now()
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        dispatcher,
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'User-Agent': 'curl/8.10.1',
            Accept: '*/*',
        },
        body: fd,
    })

    const cfRay = r.headers.get('cf-ray')
    const text = await r.text()
    console.log(`status=${r.status} cf-ray=${cfRay} in ${Date.now() - t0}ms`)
    console.log('---')
    console.log(text)
}

main().catch(e => { console.error('THREW:', e); process.exit(1) })
