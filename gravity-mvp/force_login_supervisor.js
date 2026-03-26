const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\lib\\users\\user-service.ts';
let content = fs.readFileSync(path, 'utf-8');

const target = `    const id = cookieStore.get('crm_user_id')?.value
    if (!id) return null`;

const replacement = `    let id = cookieStore.get('crm_user_id')?.value
    if (!id) id = 'u3' // Force fallback login for Supervisor`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Forced supervisor login successfully!');
} else {
    console.log('Target not found in exactly!');
}
