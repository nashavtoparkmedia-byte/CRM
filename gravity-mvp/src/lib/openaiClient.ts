/**
 * Shared OpenAI client singleton.
 *
 * Both the Whisper transcription worker and the GPT-4o analysis worker need
 * an OpenAI handle — sharing one instance avoids reading process.env twice
 * and keeps connection pooling consistent.
 *
 * Throws on first access if OPENAI_API_KEY is missing. Workers handle this by
 * letting BullMQ mark the job as failed; the rest of the CRM keeps running.
 */

import OpenAI from 'openai'

let client: OpenAI | null = null

export function getOpenAI(): OpenAI {
    if (client) return client
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
    client = new OpenAI({ apiKey })
    return client
}
