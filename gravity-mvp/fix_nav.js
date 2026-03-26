const fs = require('fs');

// 1. Fix navigation-domains.ts
const domPath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation-domains.ts';
if (fs.existsSync(domPath)) {
    let content = fs.readFileSync(domPath, 'utf-8');
    const target = `{ label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' }`;
    const replacement = `{ label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' },\n            { label: 'Справочники', href: '/settings/dictionaries', icon: Database, sectionKey: 'dictionaries' }`;
    if (content.includes(target) && !content.includes('settings/dictionaries')) {
        content = content.replace(target, replacement);
        fs.writeFileSync(domPath, content, 'utf-8');
        console.log('Fixed navigation-domains.ts!');
    }
}

// 2. Fix navigation.ts
const navPath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation.ts';
if (fs.existsSync(navPath)) {
    let content = fs.readFileSync(navPath, 'utf-8');
    const target = `{ name: "Telegram", href: "/telegram", icon: MessageSquare, sectionKey: "settings_telegram" },`;
    const replacement = `{ name: "Справочники", href: "/settings/dictionaries", icon: FileText, sectionKey: "dictionaries" },\n          { name: "Telegram", href: "/telegram", icon: MessageSquare, sectionKey: "settings_telegram" },`;
    if (content.includes(target) && !content.includes('settings/dictionaries')) {
        content = content.replace(target, replacement);
        fs.writeFileSync(navPath, content, 'utf-8');
        console.log('Fixed navigation.ts!');
    }
}
