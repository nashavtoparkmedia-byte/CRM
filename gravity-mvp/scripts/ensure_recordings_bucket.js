// Ensure the MinIO/S3 bucket for call recordings exists. Idempotent —
// safe to run on every boot. Pairs with `docker-compose ... minio-init`
// which does the same thing in the containerised dev stack.
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3')

async function main() {
    const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000'
    const accessKeyId = process.env.S3_ACCESS_KEY ?? 'crmadmin'
    const secretAccessKey = process.env.S3_SECRET_KEY ?? 'crmpassword123'
    const region = process.env.S3_REGION ?? 'us-east-1'
    const Bucket = process.env.S3_BUCKET ?? 'recordings'

    const client = new S3Client({
        endpoint, region,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
    })

    try {
        await client.send(new HeadBucketCommand({ Bucket }))
        console.log(`exists: ${endpoint}/${Bucket}`)
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            await client.send(new CreateBucketCommand({ Bucket }))
            console.log(`created: ${endpoint}/${Bucket}`)
        } else {
            console.error('UNEXPECTED:', err.message)
            process.exit(1)
        }
    }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
