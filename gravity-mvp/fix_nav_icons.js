const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation-domains.ts';
let content = fs.readFileSync(path, 'utf-8');

// 1. Add UserCog to imports
if (content.includes('MessageSquare,')) {
    content = content.replace('MessageSquare,', 'MessageSquare, UserCog, ToggleRight, ListRestart,');
}

// 2. Adjust icons in DOMAINS
const targetUsers = `    {
        key: 'users',
        label: 'Пользователи',
        icon: Users,
        items: [`;

const replacementUsers = `    {
        key: 'users',
        label: 'Пользователи',
        icon: UserCog,
        items: [`;

const targetDicts = `    {
        key: 'dictionaries',
        label: 'Справочники',
        icon: Database,
        items: [`;

const replacementDicts = `    {
        key: 'dictionaries',
        label: 'Справочники',
        icon: ListRestart,
        items: [`;

if (content.includes(targetUsers)) {
    content = content.replace(targetUsers, replacementUsers);
}
if (content.includes(targetDicts)) {
    content = content.replace(targetDicts, replacementDicts);
}

fs.writeFileSync(path, content, 'utf-8');
console.log('Fixed overlapping icons successfully!');
