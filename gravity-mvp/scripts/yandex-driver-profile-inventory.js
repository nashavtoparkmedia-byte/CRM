#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs/promises')
const path = require('node:path')
const { PrismaClient } = require('@prisma/client')

const YANDEX_ENDPOINT = 'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list'
const APPROVED_PARKS = [
  { parkCode: 'NASH_AVTOPARK', parkName: '\u041d\u0430\u0448 \u0410\u0432\u0442\u043e\u043f\u0430\u0440\u043a', externalParkId: '45e30e9d6b824c608e5d28719cb19a6e', priority: 1 },
  { parkCode: 'YOKO', parkName: 'YOKO', externalParkId: '3a23295d8d714c03b61a17a6fc86601b', priority: 2 },
  { parkCode: 'YOKO_2', parkName: 'YOKO-2', externalParkId: 'a0e45c39ffc64ecdaec96fe02cb221d9', priority: 3 },
  { parkCode: 'YOKO_3', parkName: 'YOKO-3', externalParkId: '9acdd6782806467ab284ac269a719324', priority: 4 },
  { parkCode: 'YOKO_4', parkName: 'YOKO-4', externalParkId: '02a96db4914c4a59adf874a1f07d97b7', priority: 5 },
  { parkCode: 'YOKO_DELIVERY', parkName: 'YOKO.\u0414\u043e\u0441\u0442\u0430\u0432\u043a\u0430', externalParkId: 'b3d310d51da54b15a9306420c820469e', priority: 6 },
]

function parseArgs(argv) {
  const args = {
    outputDir: process.env.PARK_INVENTORY_OUTPUT_DIR || path.join(process.cwd(), 'tmp', 'park-identity-inventory'),
    limit: Number(process.env.PARK_INVENTORY_LIMIT || 1000),
    retryBudget: Number(process.env.PARK_INVENTORY_RETRY_BUDGET || 8),
    statuses: (process.env.PARK_INVENTORY_STATUSES || 'working,dismissed').split(',').map((item) => item.trim()).filter(Boolean),
    pageDelayMs: Number(process.env.PARK_INVENTORY_PAGE_DELAY_MS || 1200),
    maxPagesPerStatus: process.env.PARK_INVENTORY_MAX_PAGES ? Number(process.env.PARK_INVENTORY_MAX_PAGES) : null,
    resume: true,
  }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--no-resume') args.resume = false
    else if (arg.startsWith('--output-dir=')) args.outputDir = arg.slice('--output-dir='.length)
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length))
    else if (arg.startsWith('--retry-budget=')) args.retryBudget = Number(arg.slice('--retry-budget='.length))
    else if (arg.startsWith('--page-delay-ms=')) args.pageDelayMs = Number(arg.slice('--page-delay-ms='.length))
    else if (arg.startsWith('--statuses=')) args.statuses = arg.slice('--statuses='.length).split(',').map((item) => item.trim()).filter(Boolean)
    else if (arg.startsWith('--max-pages-per-status=')) args.maxPagesPerStatus = Number(arg.slice('--max-pages-per-status='.length))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 120000)
  }
  const base = Math.min(120000, 1000 * 2 ** Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * Math.min(1000, base))
  return base + jitter
}

function compositeKey(externalParkId, externalDriverProfileId) {
  return `${externalParkId}:${externalDriverProfileId}`
}

function mapConnections(connections) {
  const byExternalParkId = new Map(APPROVED_PARKS.map((park) => [park.externalParkId, park]))
  const mapped = []
  const errors = []
  const seenCodes = new Set()
  const seenConnections = new Set()
  for (const connection of connections) {
    if (seenConnections.has(connection.id)) {
      errors.push(`duplicate ApiConnection id ${connection.id}`)
      continue
    }
    seenConnections.add(connection.id)
    const park = byExternalParkId.get(connection.parkId)
    if (!park) {
      errors.push(`unknown ApiConnection parkId ${connection.parkId} (${connection.id})`)
      continue
    }
    if (seenCodes.has(park.parkCode)) errors.push(`park ${park.parkCode} mapped more than once`)
    seenCodes.add(park.parkCode)
    mapped.push({ ...park, apiConnectionId: connection.id, clid: connection.clid, apiKey: connection.apiKey })
  }
  for (const park of APPROVED_PARKS) {
    if (!seenCodes.has(park.parkCode)) errors.push(`missing ApiConnection for ${park.parkCode}`)
  }
  return { mapped: mapped.sort((a, b) => a.priority - b.priority), errors }
}

function sanitizeProfile(raw, park, fetchedAt, requestedStatus) {
  const dp = raw && raw.driver_profile ? raw.driver_profile : {}
  const current = raw && raw.current_status ? raw.current_status : {}
  if (!dp.id) return null
  const phones = Array.isArray(dp.phones) ? dp.phones : []
  const fullName = [dp.last_name, dp.first_name, dp.middle_name].filter(Boolean).join(' ').trim() || null
  return {
    externalParkId: park.externalParkId,
    externalDriverProfileId: dp.id,
    parkCode: park.parkCode,
    parkName: park.parkName,
    phone: typeof phones[0] === 'string' ? phones[0] : null,
    fullName,
    employmentType: typeof dp.employment_type === 'string' ? dp.employment_type : null,
    sourceWorkStatus: typeof dp.work_status === 'string' ? dp.work_status : null,
    sourceCurrentStatus: typeof current.status === 'string' ? current.status : null,
    sourceUpdatedAt: typeof current.status_updated_at === 'string' ? current.status_updated_at : null,
    requestedStatus,
    fetchedAt,
  }
}

function dedupeProfiles(rows) {
  const byKey = new Map()
  const duplicates = new Map()
  for (const row of rows) {
    const key = compositeKey(row.externalParkId, row.externalDriverProfileId)
    if (byKey.has(key)) {
      duplicates.set(key, (duplicates.get(key) || 1) + 1)
      const previous = byKey.get(key)
      if (!previous.sourceUpdatedAt && row.sourceUpdatedAt) byKey.set(key, row)
    } else {
      byKey.set(key, row)
    }
  }
  return { profiles: Array.from(byKey.values()), duplicates: Array.from(duplicates.entries()).map(([key, count]) => ({ key, count })) }
}

function reconcile(legacyDrivers, sourceProfiles, incompleteParkCodes) {
  const sourceByExternalId = new Map()
  const sourceByKey = new Map()
  for (const source of sourceProfiles) {
    const key = compositeKey(source.externalParkId, source.externalDriverProfileId)
    sourceByKey.set(key, source)
    sourceByExternalId.set(source.externalDriverProfileId, [...(sourceByExternalId.get(source.externalDriverProfileId) || []), source])
  }
  const matchedLegacy = new Set()
  const matchedSource = new Set()
  const exact = []
  const collisions = []
  for (const legacy of legacyDrivers) {
    const provenKey = legacy.externalParkId && legacy.externalDriverProfileId ? compositeKey(legacy.externalParkId, legacy.externalDriverProfileId) : null
    if (provenKey && sourceByKey.has(provenKey)) {
      exact.push({ legacyDriverId: legacy.id, key: provenKey })
      matchedLegacy.add(legacy.id)
      matchedSource.add(provenKey)
      continue
    }
    const candidates = sourceByExternalId.get(legacy.yandexDriverId) || []
    if (candidates.length === 1) {
      const key = compositeKey(candidates[0].externalParkId, candidates[0].externalDriverProfileId)
      exact.push({ legacyDriverId: legacy.id, key })
      matchedLegacy.add(legacy.id)
      matchedSource.add(key)
    } else if (candidates.length > 1) {
      collisions.push({ legacyDriverId: legacy.id, candidateKeys: candidates.map((candidate) => compositeKey(candidate.externalParkId, candidate.externalDriverProfileId)), reason: 'external profile id appears in multiple parks' })
    }
  }
  const sourceOnly = sourceProfiles.filter((source) => !matchedSource.has(compositeKey(source.externalParkId, source.externalDriverProfileId)))
  const legacyOnly = incompleteParkCodes.length > 0 ? [] : legacyDrivers.filter((driver) => !matchedLegacy.has(driver.id))
  const byPhone = new Map()
  for (const source of sourceProfiles) {
    if (!source.phone) continue
    byPhone.set(source.phone, [...(byPhone.get(source.phone) || []), source])
  }
  const phoneMultiPark = Array.from(byPhone.entries())
    .map(([phone, profiles]) => ({
      phone,
      parkCodes: Array.from(new Set(profiles.map((profile) => profile.parkCode))).sort(),
      profileKeys: profiles.map((profile) => compositeKey(profile.externalParkId, profile.externalDriverProfileId)).sort(),
    }))
    .filter((item) => item.parkCodes.length > 1)
  return { exactMatches: exact, sourceOnly, legacyOnly, collisions, phoneMultiPark, incompleteSource: incompleteParkCodes.length > 0 }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function fetchPage(park, requestedStatus, offset, args) {
  const payload = {
    query: { park: { id: park.externalParkId }, driver: { status: [requestedStatus] } },
    fields: {
      driver_profile: ['id', 'first_name', 'last_name', 'middle_name', 'phones', 'work_status', 'created_date', 'employment_type', 'driver_license'],
      current_status: ['status', 'status_updated_at'],
    },
    limit: args.limit,
    offset,
  }
  let rateLimitCount = 0
  for (let attempt = 1; attempt <= args.retryBudget; attempt += 1) {
    const started = Date.now()
    const res = await fetch(YANDEX_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Client-ID': park.clid,
        'X-Api-Key': park.apiKey,
        'X-Park-Id': park.externalParkId,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (res.status === 429) {
      rateLimitCount += 1
      const delay = retryDelayMs(attempt, res.headers.get('retry-after'))
      console.log(`[inventory] ${park.parkCode} ${requestedStatus} offset=${offset}: 429 attempt=${attempt}/${args.retryBudget}; sleeping ${delay}ms`)
      await sleep(delay)
      continue
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Yandex ${res.status} ${body.slice(0, 200)} (${Date.now() - started}ms)`)
    }
    return { data: await res.json(), retries: Math.max(0, attempt - 1), rateLimitCount }
  }
  throw new Error(`retry budget exhausted after ${args.retryBudget} attempts`)
}

async function inventoryPark(park, args, checkpointFile) {
  const checkpoint = await readJson(checkpointFile, { pages: [] })
  const pages = checkpoint.pages || []
  for (const requestedStatus of args.statuses) {
    let offset = 0
    let pageIndex = 0
    while (true) {
      const existing = pages.find((page) => page.parkCode === park.parkCode && page.requestedStatus === requestedStatus && page.offset === offset && page.completed)
      if (existing && args.resume) {
        offset += args.limit
        pageIndex += 1
        if (typeof existing.total === 'number' && offset >= existing.total) break
        continue
      }
      if (args.maxPagesPerStatus && pageIndex >= args.maxPagesPerStatus) break
      const started = Date.now()
      try {
        const fetchedAt = new Date().toISOString()
        const { data, retries, rateLimitCount } = await fetchPage(park, requestedStatus, offset, args)
        const rawRows = Array.isArray(data.driver_profiles) ? data.driver_profiles : []
        const rows = rawRows.map((row) => sanitizeProfile(row, park, fetchedAt, requestedStatus)).filter(Boolean)
        const total = typeof data.total === 'number' ? data.total : rawRows.length
        const page = { parkCode: park.parkCode, requestedStatus, offset, total, completed: true, rows, retries, rateLimitCount, durationMs: Date.now() - started, errors: [] }
        pages.push(page)
        await writeJson(checkpointFile, { generatedAt: new Date().toISOString(), writes: false, pages })
        console.log(`[inventory] ${park.parkCode} ${requestedStatus} offset=${offset}: ${rows.length}/${total}`)
        offset += args.limit
        pageIndex += 1
        if (offset >= total || rawRows.length === 0) break
        if (args.pageDelayMs > 0) await sleep(args.pageDelayMs)
      } catch (error) {
        pages.push({ parkCode: park.parkCode, requestedStatus, offset, completed: false, rows: [], retries: args.retryBudget, rateLimitCount: 0, durationMs: Date.now() - started, errors: [error.message] })
        await writeJson(checkpointFile, { generatedAt: new Date().toISOString(), writes: false, pages })
        console.log(`[inventory] ${park.parkCode} ${requestedStatus} offset=${offset}: INCOMPLETE ${error.message}`)
        return pages
      }
    }
  }
  return pages
}

async function main() {
  const args = parseArgs(process.argv)
  await fs.mkdir(args.outputDir, { recursive: true })
  const checkpointFile = path.join(args.outputDir, 'inventory-checkpoint.json')
  const prisma = new PrismaClient()
  try {
    const connections = await prisma.apiConnection.findMany({ orderBy: { createdAt: 'asc' } })
    const mapped = mapConnections(connections)
    if (mapped.errors.length > 0) {
      await writeJson(path.join(args.outputDir, 'mapping-errors.json'), { writes: false, errors: mapped.errors })
      throw new Error(`Park mapping failed: ${mapped.errors.join('; ')}`)
    }

    let pages = (await readJson(checkpointFile, { pages: [] })).pages || []
    for (const park of mapped.mapped) {
      pages = await inventoryPark(park, args, checkpointFile)
    }

    const allRows = pages.flatMap((page) => page.rows || [])
    const deduped = dedupeProfiles(allRows)
    const incompleteParkCodes = Array.from(new Set(pages.filter((page) => !page.completed).map((page) => page.parkCode)))
    const legacyDrivers = await prisma.driver.findMany({
      select: { id: true, yandexDriverId: true, phone: true, fullName: true, contactId: true, dismissedAt: true },
    })
    const reconciliation = reconcile(legacyDrivers, deduped.profiles, incompleteParkCodes)
    const connectionReports = mapped.mapped.map((park) => {
      const parkPages = pages.filter((page) => page.parkCode === park.parkCode)
      const parkRows = parkPages.flatMap((page) => page.rows || [])
      const parkDedupe = dedupeProfiles(parkRows)
      return {
        apiConnectionId: park.apiConnectionId,
        parkCode: park.parkCode,
        parkName: park.parkName,
        externalParkId: park.externalParkId,
        totalPages: parkPages.length,
        totalSourceRows: parkRows.length,
        rowsAfterCompositeDedupe: parkDedupe.profiles.length,
        duplicateSourceRows: parkRows.length - parkDedupe.profiles.length,
        retries: parkPages.reduce((sum, page) => sum + (page.retries || 0), 0),
        rateLimitCount: parkPages.reduce((sum, page) => sum + (page.rateLimitCount || 0), 0),
        completionStatus: parkPages.length > 0 && parkPages.every((page) => page.completed) ? 'COMPLETE' : 'INCOMPLETE',
        errors: parkPages.flatMap((page) => page.errors || []),
      }
    })
    const summary = {
      generatedAt: new Date().toISOString(),
      writes: false,
      sixParksComplete: connectionReports.every((report) => report.completionStatus === 'COMPLETE'),
      legacyDriverTotal: legacyDrivers.length,
      sourceProfileTotal: deduped.profiles.length,
      duplicateSourceRows: allRows.length - deduped.profiles.length,
      exactMatched: reconciliation.exactMatches.length,
      sourceOnly: reconciliation.sourceOnly.length,
      orphaned: reconciliation.legacyOnly.length,
      collisions: reconciliation.collisions.length,
      unresolved: reconciliation.collisions.length + (reconciliation.incompleteSource ? legacyDrivers.length - reconciliation.exactMatches.length : 0),
      phonesInMultipleParks: reconciliation.phoneMultiPark.length,
      incompleteParkCodes,
      connections: connectionReports,
    }
    await writeJson(path.join(args.outputDir, 'source-snapshot.json'), { generatedAt: summary.generatedAt, writes: false, profiles: deduped.profiles })
    await writeJson(path.join(args.outputDir, 'source-snapshot-manifest.json'), { generatedAt: summary.generatedAt, writes: false, profileCount: deduped.profiles.length, duplicateKeys: deduped.duplicates, retention: 'dev release artifact; sanitized; no API keys or tokens' })
    await writeJson(path.join(args.outputDir, 'reconciliation-report.json'), { generatedAt: summary.generatedAt, writes: false, summary, reconciliation })
    await writeJson(path.join(args.outputDir, 'inventory-summary.json'), summary)
    console.log(JSON.stringify(summary, null, 2))
    if (!summary.sixParksComplete) process.exitCode = 2
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ writes: false, error: error.message }, null, 2))
  process.exitCode = 1
})
