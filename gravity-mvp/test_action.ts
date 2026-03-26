import { addTaskAction } from './src/app/tasks/actions';
import { prisma } from './src/lib/prisma';

async function run() {
    try {
        const task = await prisma.task.findFirst();
        if (!task) {
            console.log('No tasks found in db to test with');
            return;
        }
        console.log('Testing with Task ID:', task.id);
        await addTaskAction(task.id, 'called');
        console.log('Action called successfully!');
    } catch (err) {
        console.error('Action crashed:', err);
    }
}

run();
