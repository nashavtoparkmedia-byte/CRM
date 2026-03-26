import { resolveTask } from './src/app/tasks/actions';
import { prisma } from './src/lib/prisma';

async function run() {
    try {
        const task = await prisma.task.findFirst({ where: { isActive: true } });
        if (!task) {
            console.log('No active tasks found');
            return;
        }

        console.log('Resolving task:', task.id);
        const res = await resolveTask(task.id, 'done');
        console.log('Resolved task status:', res.status);

        const events = await prisma.taskEvent.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'desc' } });
        console.log('Last event:', events[0].eventType, events[0].payload);
    } catch (err) {
        console.error('Resolve crashed:', err);
    }
}

run();
