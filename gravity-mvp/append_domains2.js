const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation-domains.ts';
let content = fs.readFileSync(path, 'utf-8');

const target = `key: 'settings'`;

if (content.includes(target) && !content.includes(`key: 'users'`)) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`key: 'settings'`)) {
            if (lines[i - 1] && lines[i - 1].includes('{')) {
                lines[i - 1] = `    {
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
    {`;
                break;
            }
        }
    }
    fs.writeFileSync(path, lines.join('\n'), 'utf-8');
    console.log('Fixed accurately!');
} else {
    console.log('Users already present or target not found!');
}
