import { prisma } from '../src/lib/prisma';
import { recalculateAllTaskAttempts } from '../src/app/tasks/actions';
import fs from 'fs';

async function main() {
    console.log('Running recalculation...');
    const result = await recalculateAllTaskAttempts();
    fs.writeFileSync('recalculation_log.txt', `Updated: ${result.updated}\nTime: ${new Date().toISOString()}`);
    console.log('Done.');
    process.exit(0);
}

main().catch(err => {
    fs.writeFileSync('recalculation_err.txt', err.stack || String(err));
    process.exit(1);
});
