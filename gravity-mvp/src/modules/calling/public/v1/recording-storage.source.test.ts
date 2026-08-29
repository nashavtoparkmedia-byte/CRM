import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (relative: string) => readFile(path.resolve(process.cwd(), relative), 'utf8')

describe('Calling recording-storage public boundary', () => {
    it('keeps the S3 SDK and credentials out of Platform Health', async () => {
        const health = await source('src/lib/health.ts')
        expect(health).toContain("probeRecordingStorageV1")
        expect(health).not.toContain('@aws-sdk/client-s3')
        expect(health).not.toContain('S3_SECRET_KEY')
        expect(health).not.toContain('new S3Client')
    })

    it('exposes a narrow probe, not the provider client', async () => {
        const capability = await source('src/modules/calling/public/v1/recording-storage.ts')
        expect(capability).toContain('export async function probeRecordingStorageV1')
        expect(capability).not.toContain('export { getClient')
        expect(capability).not.toContain('export function getClient')
    })
})
