const fs = require('fs');
const filePath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\page.tsx';
let content = fs.readFileSync(filePath, 'utf-8');

const target = `<div className="flex-1 overflow-y-auto p-4 custom-scrollbar">`;
const replacement = `<div className="flex-1 overflow-auto p-4 custom-scrollbar">`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('Fixed scroll successfully!');
} else {
    console.log('Target not found exactly. Trying lines split.');
    const lines = content.split('\n');
    const fixedLines = lines.map(l => l.includes('overflow-y-auto p-4 custom-scrollbar') ? l.replace('overflow-y-auto', 'overflow-auto') : l);
    fs.writeFileSync(filePath, fixedLines.join('\n'), 'utf-8');
    console.log('Fallback scroll fixed executed!');
}
