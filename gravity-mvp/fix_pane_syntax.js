const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const target = `import { { useUpdateTask, useResolveTask }`;
const replacement = `import { useUpdateTask, useResolveTask }`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Fixed syntax correctly!');
} else {
    console.log('Target for syntax fix not found');
}
