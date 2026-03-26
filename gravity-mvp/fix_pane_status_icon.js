const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const lines = content.split('\n');
const idx = lines.findIndex(l => l.includes('onChange={(e) => updateTask.mutate({ id: task.id, patch: { status: e.target.value'));

if (idx !== -1) {
    // Insert div container before <select>
    // idx-1 is the <select line
    lines.splice(idx - 1, 0, `                        <div className="flex items-center gap-1 -ml-1">`, `                            {isOverdue && <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />}`);
    
    // Find matching </select>
    for (let i = idx + 2; i < lines.length; i++) {
        if (lines[i].includes('</select>')) {
            lines.splice(i + 1, 0, `                        </div>`);
            break;
        }
    }
    fs.writeFileSync(path, lines.join('\n'), 'utf-8');
    console.log('Overdue Status Alarm Icon applied successfully!');
} else {
    console.log('Target for status mapping not found!');
}
