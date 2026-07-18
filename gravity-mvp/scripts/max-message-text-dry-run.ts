#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'
// @ts-expect-error Node 24 direct TypeScript execution requires the explicit extension.
import { buildMaxTextRepairDryRun, type MaxTextRepairDryRun } from '../src/lib/max-message-text-forensics.ts'

type MaxMessageRow = {
  id: string
  content: string | null
  metadata: unknown
  _count: { attachments: number }
}

export type MaxMessageReadClient = {
  message: {
    findMany(args: Record<string, unknown>): Promise<MaxMessageRow[]>
  }
}

export interface MaxMessageDbDryRun {
  generatedAt: string
  source: 'read_only_database'
  report: MaxTextRepairDryRun
}

export async function collectMaxMessageTextDryRun(
  client: MaxMessageReadClient,
  batchSize = 500,
): Promise<MaxMessageDbDryRun> {
  const messages: Array<{
    id: string
    content: string | null
    metadata: unknown
    attachmentCount: number
  }> = []
  let cursor: string | undefined

  while (true) {
    const rows = await client.message.findMany({
      where: { channel: 'max' },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        content: true,
        metadata: true,
        _count: { select: { attachments: true } },
      },
    })

    for (const row of rows) {
      messages.push({
        id: row.id,
        content: row.content,
        metadata: row.metadata,
        attachmentCount: row._count.attachments,
      })
    }

    if (rows.length < batchSize) break
    cursor = rows.at(-1)?.id
    if (!cursor) break
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'read_only_database',
    report: buildMaxTextRepairDryRun(messages),
  }
}

async function main() {
  if (process.env.MAX_FORENSIC_READ_ONLY !== '1') {
    throw new Error('Set MAX_FORENSIC_READ_ONLY=1 to acknowledge the read-only run')
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required')
  }

  const outputArg = process.argv.find(value => value.startsWith('--output='))
  const outputPath = outputArg?.slice('--output='.length)
  const batchArg = process.argv.find(value => value.startsWith('--batch-size='))
  const batchSize = batchArg ? Number(batchArg.slice('--batch-size='.length)) : 500
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error('--batch-size must be an integer between 1 and 5000')
  }

  const prisma = new PrismaClient()
  try {
    const result = await collectMaxMessageTextDryRun(
      prisma as unknown as MaxMessageReadClient,
      batchSize,
    )
    const json = `${JSON.stringify(result, null, 2)}\n`
    if (outputPath) {
      await writeFile(outputPath, json, 'utf8')
    } else {
      process.stdout.write(json)
    }
  } finally {
    await prisma.$disconnect()
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isDirectRun) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
