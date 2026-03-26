const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const target = `                </div>
                    <div>
                        <h4 className="text-[12px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">`;

const replacement = `                </div>
                {task.description && (
                    <div>
                        <h4 className="text-[12px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Syntaxes restored correctly!');
} else {
    console.log('Target for syntax restore not found!');
}
