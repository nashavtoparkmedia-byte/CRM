const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const target = `{dicts?.scenarios?.find((s: any) => s.id === scenario)?.label || 'Контакт'} → {dicts?.events?.find((e: any) => e.id === task.type)?.label || task.type}`;
const replacement = `{dicts?.events?.find((e: any) => e.id === task.type)?.label || task.type}`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Fixed header title flawlessly!');
} else {
    console.log('Target for header title not found!');
}
