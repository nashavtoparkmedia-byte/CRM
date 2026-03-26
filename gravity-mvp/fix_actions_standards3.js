const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\actions.ts';
let content = fs.readFileSync(path, 'utf-8');

// 1. Add Past due protection on updateTask
const updateTaskTarget = `    if (patch.title !== undefined) data.title = patch.title`;
const updateTaskReplacement = `    if (patch.dueAt !== undefined && patch.dueAt !== null) {
        if (new Date(patch.dueAt) < new Date()) {
            throw new Error('Нельзя установить срок в прошлом');
        }
    }
    if (patch.title !== undefined) data.title = patch.title`;

if (content.includes(updateTaskTarget)) {
    content = content.replace(updateTaskTarget, updateTaskReplacement);
    console.log('Past due protection added to backend updateTask!');
}

// 2. Add Overdue Event logging on getTasks
const getTasksTarget = `await prisma.task.updateMany({
        where: { isActive: true, dueAt: { lt: new Date() }, status: { in: ['todo', 'in_progress', 'waiting_reply'] } },
        data: { status: 'overdue' }
    });`;

const getTasksReplacement = `const nowTime = new Date();
    const itemsToOverdue = await prisma.task.findMany({
        where: { isActive: true, dueAt: { lt: nowTime }, status: { in: ['todo', 'in_progress', 'waiting_reply'] } },
        select: { id: true, status: true }
    });
    
    if (itemsToOverdue.length > 0) {
        await prisma.task.updateMany({
            where: { id: { in: itemsToOverdue.map(t => t.id) } },
            data: { status: 'overdue' }
        });
        const { logTaskEvent } = await import('@/lib/tasks/task-event-service');
        for (const t of itemsToOverdue) {
            await logTaskEvent(t.id, 'status_changed', { from: t.status, to: 'overdue' }, { type: 'system' });
        }
    }`;

if (content.includes(getTasksTarget)) {
    content = content.replace(getTasksTarget, getTasksReplacement);
    console.log('Overdue auto-logging events injected flawlessly!');
}

fs.writeFileSync(path, content, 'utf-8');
console.log('Actions updated for auto-assignment and overdue triggers!');
