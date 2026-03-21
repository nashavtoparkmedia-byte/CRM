
import { prisma } from '../src/lib/prisma'

async function debugColumns() {
    console.log("--- Checking Chat Table Columns ---")
    try {
        const columns: any[] = await prisma.$queryRaw`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'Chat'
        `
        console.log("Column Names found:")
        columns.forEach(c => console.log(`- ${c.column_name} (${c.data_type})`))
        
        console.log("\n--- Checking TelegramConnection Table ---")
        const tgColumns: any[] = await prisma.$queryRaw`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'TelegramConnection'
        `
        tgColumns.forEach(c => console.log(`- ${c.column_name}`))

    } catch (err) {
        console.error("Failed to query information_schema:")
        console.error(err)
    } finally {
        await prisma.$disconnect()
    }
}

debugColumns()
