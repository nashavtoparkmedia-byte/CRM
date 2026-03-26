const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const lines = content.split('\n');
const startIdx = lines.findIndex(l => l.includes('<MetaField label="Статус"'));

if (startIdx !== -1) {
    // Exact lines positions mapping
    lines[startIdx + 1] = `                        <div className="flex items-center gap-1 -ml-1">`;
    lines[startIdx + 2] = `                            {isOverdue && <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />}`;
    lines[startIdx + 3] = `                            <select`;
    lines[startIdx + 4] = `                                value={task.status}`;
    
    fs.writeFileSync(path, lines.join('\n'), 'utf-8');
    console.log('Fixed overlapping Select syntax correctly!');
} else {
    console.log('Target for overlapping syntax not found!');
}
