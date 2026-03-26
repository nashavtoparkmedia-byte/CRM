const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\actions.ts';
let content = fs.readFileSync(path, 'utf-8');

// 1. Add Retroactive Assignee Fix to getTasks
const getTasksTarget = `await prisma.task.updateMany({
        where: { isActive: true, dueAt: { lt: new Date() }, status: { in: ['todo', 'in_progress', 'waiting_reply'] } },
        data: { status: 'overdue' }
    });`;

const getTasksReplacement = `await prisma.task.updateMany({
        where: { isActive: true, dueAt: { lt: new Date() }, status: { in: ['todo', 'in_progress', 'waiting_reply'] } },
        data: { status: 'overdue' }
    });
    // Retroactive Assignee Fix for existing empty rows
    await prisma.task.updateMany({
        where: { assigneeId: null },
        data: { assigneeId: 'u3' }
    });`;

if (content.includes(getTasksTarget)) {
    content = content.replace(getTasksTarget, getTasksReplacement);
    console.log('Retro Assignee Fix injected on getTasks!');
}

// 2. Add Same Retro Fix to getTaskById & getTaskDetails so clicking single items triggers fix
const getTaskByIdTarget = `export async function getTaskById(id: string): Promise<TaskDTO | null> {
    const task = await prisma.task.findUnique({`;

const getTaskByIdReplacement = `export async function getTaskById(id: string): Promise<TaskDTO | null> {
    await prisma.task.updateMany({
        where: { id, assigneeId: null },
        data: { assigneeId: 'u3' }
    });
    const task = await prisma.task.findUnique({`;

if (content.includes(getTaskByIdTarget)) {
    content = content.replace(getTaskByIdTarget, getTaskByIdReplacement);
    console.log('Retro Assignee Fix injected on getTaskById!');
}

const getTaskDetailsTarget = `export async function getTaskDetails(id: string): Promise<TaskDetailDTO | null> {
    const task = await prisma.task.findUnique({`;

const getTaskDetailsReplacement = `export async function getTaskDetails(id: string): Promise<TaskDetailDTO | null> {
    await prisma.task.updateMany({
        where: { id, assigneeId: null },
        data: { assigneeId: 'u3' }
    });
    const task = await prisma.task.findUnique({`;

if (content.includes(getTaskDetailsTarget)) {
    content = content.replace(getTaskDetailsTarget, getTaskDetailsReplacement);
    console.log('Retro Assignee Fix injected on getTaskDetails!');
}

fs.writeFileSync(path, content, 'utf-8');
console.log('Backend Actions full operations ready!');
