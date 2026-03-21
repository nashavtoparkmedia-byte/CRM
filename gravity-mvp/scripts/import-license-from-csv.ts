import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const prisma = new PrismaClient()

async function importLicenses() {
    const csvPath = 'C:\\Users\\mixx\\Downloads\\contractor_profiles_manager_segment_v2_contractors.csv'
    
    if (!fs.existsSync(csvPath)) {
        console.error(`File not found: ${csvPath}`)
        return
    }

    console.log(`Reading file: ${csvPath}...`)
    const content = fs.readFileSync(csvPath, 'utf8')
    const lines = content.split('\n')
    
    const header = lines[0].split(';')
    console.log(`Header found: ${header.join(', ')}`)

    const yandexIdIdx = 1 // ID исполнителя
    const licenseIdx = 9    // Водительское удостоверение
    const nameIdx = 2       // ФИО

    let updatedCount = 0
    let skippedCount = 0
    let errorCount = 0

    console.log(`Starting import for ${lines.length - 1} records...`)

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue

        const columns = line.split(';')
        const yandexDriverId = columns[yandexIdIdx]
        const licenseNumber = columns[licenseIdx]?.trim()
        const fullName = columns[nameIdx]

        if (!yandexDriverId || !licenseNumber || licenseNumber === '—') {
            skippedCount++
            continue
        }

        try {
            const driver = await prisma.driver.updateMany({
                where: { yandexDriverId },
                data: { licenseNumber }
            })

            if (driver.count > 0) {
                updatedCount += driver.count
                if (updatedCount % 100 === 0) {
                    console.log(`Progress: ${updatedCount} drivers updated...`)
                }
            } else {
                skippedCount++
            }
        } catch (error) {
            console.error(`Error updating driver ${yandexDriverId} (${fullName}):`, error)
            errorCount++
        }
    }

    console.log('--- Import completed ---')
    console.log(`Total updated: ${updatedCount}`)
    console.log(`Total skipped (no license or driver not found): ${skippedCount}`)
    console.log(`Total errors: ${errorCount}`)
}

importLicenses()
    .catch(err => {
        console.error('Fatal error during import:', err)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
