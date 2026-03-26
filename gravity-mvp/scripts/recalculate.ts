import { recalculateAllTaskAttempts } from './src/app/tasks/actions';

async function main() {
    console.log('Starting recalculation of task attempts...');
    const result = await recalculateAllTaskAttempts();
    console.log(`Finished. Updated ${result.updated} tasks.`);
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
