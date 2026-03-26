const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation-domains.ts';
let content = fs.readFileSync(path, 'utf-8');

const target = `    {
        key: 'settings',`;

const replacement = `    {
        key: 'users',
        label: 'Пользователи',
        icon: Users,
        items: [
            { label: 'Все менеджеры', href: '/users', icon: Users, sectionKey: 'users' }
        ]
    },
    {
        key: 'dictionaries',
        label: 'Справочники',
        icon: Database,
        items: [
            { label: 'Справочники', href: '/settings/dictionaries', icon: Database, sectionKey: 'dictionaries' }
        ]
    },
    {
        key: 'settings',`;

if (content.includes(target) && !content.includes(`key: 'users',`)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Injected Users and Dictionaries DOMAINS successfully!');
} else {
    console.log('Target settings not found or users already there!');
}
