import { getDriversWithCells } from './src/app/drivers/actions'

async function debug() {
    console.log("--- DEBUG START ---")
    const result = await getDriversWithCells(1, 10, { excludeGone: true })
    console.log(`Total drivers found with excludeGone=true: ${result.total}`)
    
    result.drivers.forEach(d => {
        const lastOrder = d.lastOrderAt ? d.lastOrderAt.toISOString() : 'NULL'
        const tripless = d.cells.every(c => c.tripCount === 0)
        console.log(`Driver: ${d.fullName}, lastOrderAt: ${lastOrder}, All Red Cells: ${tripless}`)
    })
    console.log("--- DEBUG END ---")
}

debug().catch(console.error)
