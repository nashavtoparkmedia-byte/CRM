// Bulk cleanup phantom-phones созданных из @lid (last10-цифр) для @c.us оборачивания.
// Источник bug закрыт в commit 2249fde, но накопленные phantom'ы остаются — этот
// скрипт их обнаруживает по pattern и зачищает.
//
// Логика:
//   1. SCAN: phantom = ContactPhone с source='whatsapp', phone в формате +7XXXXXXXXXX,
//      where last10 цифр == last10 цифр любого @lid-identity того же contact'а.
//   2. CATEGORIZE:
//      - HAS_MASTER (driver): chat.driverId → Driver → master Contact (со своим phone)
//      - HAS_MASTER (name):   name match с park-suffix-strip (Yoko / Наш Автопарк / UBER / etc),
//                             только single-master (ambiguous skipped)
//      - ORPHAN: ни то ни другое
//   3. EXECUTE:
//      - HAS_MASTER: POST /api/contacts/<phantom>/merge-to/<master>, потом repoint @lid identity
//        к master.primaryPhoneId, deactivate @c.us identity, soft-delete phantom phone
//      - ORPHAN: repoint @lid к null phoneId, deactivate @c.us identity, soft-delete phantom phone
//
// Запуск: node gravity-mvp/scripts/bulk_phantom_lid_cleanup.js

const { PrismaClient } = require('@prisma/client')
const { setContactIdentityPhoneV1, deactivateContactIdentityByExternalIdV1 } = require('../src/modules/contacts/public/v1/legacy-prisma-contact-identity-maintenance-adapter')
const prisma = new PrismaClient()

const CRM_URL = process.env.CRM_URL || 'http://localhost:3002'
const MERGED_BY = 'bulk-phantom-cleanup-2026-05-24'

const SCAN_SQL = `
WITH phantoms AS (
    SELECT
        cp.id AS phantom_phone_id, cp.phone, cp."contactId" AS phantom_id,
        c."displayName" AS phantom_name,
        ci.id AS lid_identity_id, ci."externalId" AS lid_external_id
    FROM "ContactPhone" cp
    JOIN "Contact" c ON c.id = cp."contactId"
    JOIN "ContactIdentity" ci ON ci."contactId" = cp."contactId" AND ci.channel = 'whatsapp'
    WHERE cp."isActive" = true AND cp.source = 'whatsapp' AND cp.phone ~ '^\\+7\\d{10}$'
      AND LENGTH(ci."externalId") > 11
      AND RIGHT(REGEXP_REPLACE(cp.phone, '\\D', '', 'g'), 10) = RIGHT(ci."externalId", 10)
      AND c."isArchived" = false
),
masters_d AS (
    SELECT DISTINCT p.phantom_id, m.id AS master_id
    FROM phantoms p
    JOIN "Chat" ch ON ch."contactId" = p.phantom_id AND ch."driverId" IS NOT NULL
    JOIN "Driver" d ON d.id = ch."driverId"
    JOIN "ContactPhone" mp ON mp.phone = d.phone AND mp."isActive" = true
    JOIN "Contact" m ON m.id = mp."contactId"
    WHERE m.id != p.phantom_id AND m."isArchived" = false
),
masters_n AS (
    SELECT phantom_id, master_id FROM (
        SELECT
            p.phantom_id, m.id AS master_id,
            COUNT(*) OVER (PARTITION BY p.phantom_id) AS cnt
        FROM phantoms p
        JOIN "Contact" m ON m.id != p.phantom_id
                      AND m."isArchived" = false
                      AND m."yandexDriverId" IS NOT NULL
                      AND REGEXP_REPLACE(p.phantom_name, ' (Yoko|Наш Автопарк|UBER|Большой Босс|Big Boss)$', '') = m."displayName"
        WHERE p.phantom_name !~ '^\\+\\d' AND p.phantom_name != 'Неизвестный номер'
    ) sub WHERE cnt = 1
)
SELECT
    p.phantom_phone_id, p.phone AS phantom_phone, p.phantom_id, p.phantom_name,
    p.lid_identity_id,
    COALESCE(d.master_id, n.master_id) AS master_id
FROM phantoms p
LEFT JOIN masters_d d ON d.phantom_id = p.phantom_id
LEFT JOIN masters_n n ON n.phantom_id = p.phantom_id
ORDER BY (CASE WHEN COALESCE(d.master_id, n.master_id) IS NULL THEN 1 ELSE 0 END), p.phantom_name
`

async function mergeViaApi(sourceContactId, targetContactId) {
    const res = await fetch(`${CRM_URL}/api/contacts/${sourceContactId}/merge-to/${targetContactId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergedBy: MERGED_BY })
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`merge ${res.status}: ${body}`)
    return JSON.parse(body)
}

async function deletePhoneViaApi(contactId, phoneId) {
    const res = await fetch(`${CRM_URL}/api/contacts/${contactId}/phones/${phoneId}`, { method: 'DELETE' })
    if (!res.ok) {
        const body = await res.text()
        throw new Error(`delete phone ${res.status}: ${body}`)
    }
    return await res.json()
}

async function processWithMaster(p) {
    // 1. Merge phantom → master
    const m = await mergeViaApi(p.phantom_id, p.master_id)

    // 2. Repoint @lid identity к master.primaryPhoneId (если есть)
    const master = await prisma.contact.findUnique({
        where: { id: p.master_id },
        select: { primaryPhoneId: true }
    })
    if (master?.primaryPhoneId) {
        await setContactIdentityPhoneV1(p.lid_identity_id, master.primaryPhoneId)
    } else {
        // У master нет primary phone — оставим identity orphan (phoneId=null)
        await setContactIdentityPhoneV1(p.lid_identity_id, null)
    }

    // 3. Deactivate @c.us identity if exists (externalId = phantom phone digits)
    const phantomDigits = p.phantom_phone.replace(/\D/g, '')
    await deactivateContactIdentityByExternalIdV1(p.master_id, phantomDigits)

    // 4. Soft-delete phantom phone
    await deletePhoneViaApi(p.master_id, p.phantom_phone_id)

    return { merged: true, mergeRecordId: m.mergeRecordId }
}

async function processOrphan(p) {
    // Repoint @lid identity к null phoneId (orphan)
    await prisma.contactIdentity.update({
        where: { id: p.lid_identity_id },
        data:  { phoneId: null }
    })

    // Deactivate @c.us identity if exists
    const phantomDigits = p.phantom_phone.replace(/\D/g, '')
    await deactivateContactIdentityByExternalIdV1(p.phantom_id, phantomDigits)

    // Soft-delete phantom phone (через API — он также очистит primaryPhoneId)
    await deletePhoneViaApi(p.phantom_id, p.phantom_phone_id)

    return { merged: false }
}

async function main() {
    console.log(`[bulk] scanning DB for phantom @lid-phones...`)
    const all = await prisma.$queryRawUnsafe(SCAN_SQL)
    console.log(`[bulk] found ${all.length} phantoms`)

    const withMaster = all.filter(p => p.master_id)
    const orphan     = all.filter(p => !p.master_id)
    console.log(`[bulk] ${withMaster.length} with master → merge+cleanup`)
    console.log(`[bulk] ${orphan.length} orphan → cleanup only`)

    let merged = 0, cleaned = 0, failed = 0
    const failures = []

    for (const p of withMaster) {
        try {
            const r = await processWithMaster(p)
            merged++
            console.log(`[bulk]   MERGED ${p.phantom_id} (${p.phantom_name}) → ${p.master_id} [${r.mergeRecordId}]`)
        } catch (e) {
            failed++
            failures.push({ id: p.phantom_id, name: p.phantom_name, error: e.message })
            console.error(`[bulk]   FAIL merge ${p.phantom_id} (${p.phantom_name}): ${e.message}`)
        }
    }

    for (const p of orphan) {
        try {
            await processOrphan(p)
            cleaned++
            console.log(`[bulk]   CLEANED ${p.phantom_id} (${p.phantom_name})`)
        } catch (e) {
            failed++
            failures.push({ id: p.phantom_id, name: p.phantom_name, error: e.message })
            console.error(`[bulk]   FAIL orphan ${p.phantom_id} (${p.phantom_name}): ${e.message}`)
        }
    }

    console.log(`\n[bulk] ════════════════════════════════════`)
    console.log(`[bulk] DONE: merged=${merged}, cleaned=${cleaned}, failed=${failed}`)
    if (failures.length) {
        console.log(`[bulk] failures:`)
        failures.forEach(f => console.log(`  - ${f.id} (${f.name}): ${f.error}`))
    }
    await prisma.$disconnect()
}

main().catch(err => { console.error('[bulk] FATAL:', err); process.exit(1) })
