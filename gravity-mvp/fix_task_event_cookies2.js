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

const lines = content.split('\n');
const startIdx = lines.findIndex(l => l.includes('export async function logTaskEvent'));

if (startIdx !== -1) {
    for (let i = startIdx; i < lines.length; i++) {
        if (lines[i].includes('})')) {
            lines.splice(startIdx, i - startIdx + 1, replacement);
            break;
        }
    }
    fs.writeFileSync(path, lines.join('\n'), 'utf-8');
    console.log('File successfully updated with raw index method!');
} else {
    console.log('Start index not found');
}
