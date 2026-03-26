const fs = require('fs');
const filePath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(filePath, 'utf-8');

if (!content.includes('Database,') && content.includes('AlertTriangle,')) {
    content = content.replace('AlertTriangle,', 'AlertTriangle,\n    Database,');
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('Fixed imports successfully!');
} else {
    console.log('Database already imported or target not found');
}
