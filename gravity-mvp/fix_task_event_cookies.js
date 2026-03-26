const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\lib\\tasks\\task-event-service.ts';
let content = fs.readFileSync(path, 'utf-8');

const replacement = `export async function logTaskEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    actor?: { type: 'system' | 'user' | 'auto'; id?: string }
) {
    const cookieStore = await cookies();
    const userId = cookieStore.get('crm_user_id')?.value;

    return prisma.taskEvent.create({
        data: {
            taskId,
            eventType,
            payload: payload as any,
            actorType: userId ? 'user' : (actor?.type || 'system'),
            actorId: userId || actor?.id || null,
        },
    });
}`;

if (content.includes('actorType: cookies().get')) {
    content = content.replace(/export async function logTaskEvent[\s\S]*?\}\s*\}\)/, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Fixed task event cookies flawlessly!');
} else {
    console.log('Target for task event not found!');
}
