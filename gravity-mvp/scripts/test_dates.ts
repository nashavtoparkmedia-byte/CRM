import { getDriversWithCells } from '../src/app/drivers/actions'

async function test() {
    try {
        console.log('Fetching drivers...')
        const result = await getDriversWithCells(1, 1, { status: 'gone' })
        if (result.drivers.length > 0) {
            const d = result.drivers[0]
            console.log('Driver found:', d.fullName)
            console.log('Hired At:', d.hiredAt)
            console.log('Dismissed At:', d.dismissedAt)
            console.log('Last Order At:', d.lastOrderAt)
            if ('hiredAt' in d) {
                console.log('SUCCESS: hiredAt exists in record')
            } else {
                console.log('FAILURE: hiredAt missing from record')
            }
        } else {
            console.log('No gone drivers found to test.')
        }
    } catch (err) {
        console.error('Test failed:', err)
    }
}

test()
