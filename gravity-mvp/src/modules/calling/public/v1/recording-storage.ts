/**
 * Calling-owned S3/MinIO capability for call recordings.
 *
 * The storage provider is deliberately kept with Calling: recordings are a
 * call-lifecycle concern. Callers receive only recording operations and a
 * health result; they cannot obtain the SDK client or provider credentials.
 */
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
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

/** Upload a call-recording file and return no provider-level handle. */
export async function uploadFile(localPath: string, objectKey: string, contentType: string): Promise<void> {
    const body = await fs.readFile(localPath)
    await getClient().send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
    }))
}

/** Generate a short-lived recording download URL. */
export async function getRecordingUrl(objectKey: string, expiresInSec = 3600): Promise<string> {
    return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }), { expiresIn: expiresInSec })
}

/** Read a recording for the Calling transcription/playback flows. */
export async function getObject(objectKey: string): Promise<Buffer> {
    const res = await getClient().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }))
    if (!res.Body) throw new Error(`empty body for ${objectKey}`)
    return streamToBuffer(res.Body as Readable)
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
    })
}

export type RecordingStorageHealthCheckV1 = {
    name: 'minio'
    ok: boolean
    ms: number
    error?: string
}

/**
 * Public, side-effect-free storage reachability probe for Platform Health.
 * It performs only HeadBucket; it never exposes an SDK client or credentials.
 */
export async function probeRecordingStorageV1(): Promise<RecordingStorageHealthCheckV1> {
    const start = Date.now()
    try {
        await getClient().send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
        return { name: 'minio', ok: true, ms: Date.now() - start }
    } catch (error: any) {
        return { name: 'minio', ok: false, ms: Date.now() - start, error: error?.message ?? String(error) }
    }
}
