const fs = require('fs');
const filePath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\actions.ts';
let content = fs.readFileSync(filePath, 'utf-8');

const appendText = `
// ─── Operational Actions Logger ───────────────────────────────────────────

export async function addTaskAction(id: string, actionType: string): Promise<void> {
    await logTaskEvent(id, actionType, {}, { type: 'user' })
}
`;

if (!content.includes('addTaskAction')) {
    content += appendText;
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('Appended addTaskAction successfully!');
} else {
    console.log('addTaskAction already exists!');
}
