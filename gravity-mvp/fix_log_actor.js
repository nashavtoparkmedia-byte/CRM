const fs = require('fs');
const filePath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\lib\\tasks\\task-event-service.ts';
let content = fs.readFileSync(filePath, 'utf-8');

if (!content.includes('import { cookies }')) {
    content = `import { cookies } from 'next/headers'\n` + content;
}

const target1 = `actorType: actor?.type ?? 'system'`;
const target2 = `actorId: actor?.id ?? null`;

if (content.includes(target1) && content.includes(target2)) {
    content = content.replace(target1, `actorType: cookies().get('crm_user_id')?.value ? 'user' : (actor?.type || 'system')`);
    content = content.replace(target2, `actorId: cookies().get('crm_user_id')?.value || actor?.id || null`);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('Fixed logTaskEvent successfully!');
} else {
    console.log('Target not found!');
}
