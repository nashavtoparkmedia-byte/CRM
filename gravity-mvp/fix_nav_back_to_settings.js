const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation-domains.ts';
let content = fs.readFileSync(path, 'utf-8');

// 1. Remove users domain
const usersRegex = /\{\s*key:\s*'users'[\s\S]*?items:\s*\[[\s\S]*?\]\s*\},\s*/;
const dictRegex = /\{\s*key:\s*'dictionaries'[\s\S]*?items:\s*\[[\s\S]*?\]\s*\},\s*/;

if (content.match(usersRegex)) {
    content = content.replace(usersRegex, '');
    console.log('Removed Users Domain root');
}
if (content.match(dictRegex)) {
    content = content.replace(dictRegex, '');
    console.log('Removed Dictionaries Domain root');
}

// 2. Append to Settings
const targetItems = `        items: [
            { label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' },
            { label: 'Справочники', href: '/settings/dictionaries', icon: Database, sectionKey: 'dictionaries' }
        ],`;

const replacementItems = `        items: [
            { label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' },
            { label: 'Справочники', href: '/settings/dictionaries', icon: ListRestart, sectionKey: 'dictionaries' },
            { label: 'Пользователи', href: '/users', icon: UserCog, sectionKey: 'users' }
        ],`;

if (content.includes(targetItems)) {
    content = content.replace(targetItems, replacementItems);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Appended items back to settings list flawlessly!');
} else {
    // try fallback for Database/ListRestart if it was modified previously
    const targetItemsFallback = `        items: [
            { label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' },
            { label: 'Справочники', href: '/settings/dictionaries', icon: ListRestart, sectionKey: 'dictionaries' }
        ],`;
    if (content.includes(targetItemsFallback)) {
         const replacementItemsFallback = `        items: [
            { label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' },
            { label: 'Справочники', href: '/settings/dictionaries', icon: ListRestart, sectionKey: 'dictionaries' },
            { label: 'Пользователи', href: '/users', icon: UserCog, sectionKey: 'users' }
        ],`;
         content = content.replace(targetItemsFallback, replacementItemsFallback);
         fs.writeFileSync(path, content, 'utf-8');
         console.log('Appended items back with fallback list flawlessly!');
    } else {
        console.log('Target Settings items not found for appending!');
    }
}
