/**
 * S3-compatible storage client for call recordings (and future blobs).
 *
 * Talks to MinIO in dev and Yandex Object Storage in prod with the same
 * code — set S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY + S3_BUCKET in
 * gravity-mvp/.env. forcePathStyle is required for MinIO; harmless for
 * Yandex (they support both styles).
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'stream'
import fs from 'fs/promises'

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000'
const accessKeyId = process.env.S3_ACCESS_KEY ?? 'crmadmin'
const secretAccessKey = process.env.S3_SECRET_KEY ?? 'crmpassword123'
const region = process.env.S3_REGION ?? 'us-east-1'

export const S3_BUCKET = process.env.S3_BUCKET ?? 'recordings'

let client: S3Client | null = null

function getClient(): S3Client {
    if (!client) {
        client = new S3Client({
            endpoint,
            region,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: true,
        })
    }
    return client
}

/** Upload a local file to S3 and return its object key. */
export async function uploadFile(localPath: string, objectKey: string, contentType: string): Promise<void> {
    const body = await fs.readFile(localPath)
    await getClient().send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
    }))
}

/**
 * Generate a short-lived presigned URL for downloading a recording.
 * Default 1 hour — enough for one playback session, prevents URL sharing.
 */
export async function getRecordingUrl(objectKey: string, expiresInSec = 3600): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: objectKey })
    return getSignedUrl(getClient(), cmd, { expiresIn: expiresInSec })
}

/**
 * Download an object as a Buffer. Used by the transcription worker — it needs
 * to feed the MP3 bytes directly to the Whisper SDK, which accepts File / Blob.
 * For typical 1-3 minute calls the MP3 is <2MB at 64kbps stereo, so loading
 * fully into memory is fine and simpler than streaming.
 */
export async function getObject(objectKey: string): Promise<Buffer> {
    const res = await getClient().send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
    }))
    if (!res.Body) throw new Error(`empty body for ${objectKey}`)
    return await streamToBuffer(res.Body as Readable)
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
    })
}
