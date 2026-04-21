// One-time migration: create scenario_field_settings table
const { PrismaClient } = require('@prisma/client')

async function main() {
    const prisma = new PrismaClient()
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS scenario_field_settings (
                id           TEXT PRIMARY KEY,
                "scenarioId" TEXT NOT NULL,
                "fieldId"    TEXT NOT NULL,
                "showInList" BOOLEAN,
                "showInCard" BOOLEAN,
                "filterable" BOOLEAN,
                "sortable"   BOOLEAN,
                "groupable"  BOOLEAN,
                "order"      INTEGER,
                "updatedAt"  TIMESTAMP DEFAULT NOW(),
                "updatedBy"  TEXT,
                CONSTRAINT scenario_field_settings_unique UNIQUE("scenarioId", "fieldId")
            );
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS scenario_field_settings_scenario_idx
            ON scenario_field_settings("scenarioId");
        `)
        console.log('Done: scenario_field_settings table created (or already exists)')
    } catch (err) {
        console.error('Error:', err.message)
    } finally {
        await prisma.$disconnect()
    }
}

main()
