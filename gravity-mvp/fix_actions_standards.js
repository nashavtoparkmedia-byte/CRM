const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\actions.ts';
let content = fs.readFileSync(path, 'utf-8');

// 1. Add cookies support on createTask
const createTarget = `export async function createTask(input: CreateTaskInput): Promise<TaskDTO> {
    const task = await prisma.task.create({
        data: {`;

const createReplacement = `export async function createTask(input: CreateTaskInput): Promise<TaskDTO> {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const currentUserId = cookieStore.get('crm_user_id')?.value || 'u3';

    const task = await prisma.task.create({
        data: {`;

if (content.includes(createTarget)) {
    content = content.replace(createTarget, createReplacement);
}

const assigneeTarget = `assigneeId: input.assigneeId,`;
const assigneeReplacement = `assigneeId: input.assigneeId || currentUserId,`;
if (content.includes(assigneeTarget)) {
    content = content.replace(assigneeTarget, assigneeReplacement);
}

// 2. Add Auto Overdue on getTasks & fallback for single requests 
const getTasksTarget = `export async function getTasks(
    filters: TaskFilters = {},
    sort: { field: string; direction: 'asc' | 'desc' } = { field: 'createdAt', direction: 'desc' }
): Promise<{ tasks: TaskDTO[]; total: number }> {
    const where = buildWhere(filters)`;

const getTasksReplacement = `export async function getTasks(
    filters: TaskFilters = {},
    sort: { field: string; direction: 'asc' | 'desc' } = { field: 'createdAt', direction: 'desc' }
): Promise<{ tasks: TaskDTO[]; total: number }> {
    await prisma.task.updateMany({
        where: { isActive: true, dueAt: { lt: new Date() }, status: { in: ['todo', 'in_progress', 'waiting_reply'] } },
        data: { status: 'overdue' }
    });

    const where = buildWhere(filters)`;

if (content.includes(getTasksTarget)) {
    content = content.replace(getTasksTarget, getTasksReplacement);
}

// 3. Add Empty Patch Check on updateTask
const updateTarget = `    const task = await prisma.task.update({
        where: { id },
        data,`;

const updateReplacement = `    if (Object.keys(data).length === 0) {
         const t = await prisma.task.findUniqueOrThrow({ where: { id }, include: { driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } } } });
         return toTaskDTO(t);
    }

    const task = await prisma.task.update({
        where: { id },
        data,`;

if (content.includes(updateTarget)) {
    content = content.replace(updateTarget, updateReplacement);
}

fs.writeFileSync(path, content, 'utf-8');
console.log('Actions updated flawless!');
