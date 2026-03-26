const fs = require('fs');

// 1. Fix navigation-domains.ts (Add Users to Sidebar)
const domPath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation-domains.ts';
if (fs.existsSync(domPath)) {
    let content = fs.readFileSync(domPath, 'utf-8');
    const target = `{
        key: 'dashboard',
        label: 'Главная',`;
    const replacement = `{
        key: 'users',
        label: 'Пользователи',
        icon: Users,
        items: [
            { label: 'Все менеджеры', href: '/users', icon: Users, sectionKey: 'users' }
        ]
    },
    {
        key: 'dashboard',
        label: 'Главная',`;
    if (content.includes(target) && !content.includes('/users')) {
        content = content.replace(target, replacement);
        fs.writeFileSync(domPath, content, 'utf-8');
        console.log('Fixed navigation-domains.ts!');
    }
}

// 2. Fix navigation.ts (Add Users to Sidebar)
const navPath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\config\\navigation.ts';
if (fs.existsSync(navPath)) {
    let content = fs.readFileSync(navPath, 'utf-8');
    const target = `{
    title: "Исполнители",
    items: [`;
    const replacement = `{
    title: "Учетная запись",
    items: [
      { name: "Пользователи", href: "/users", icon: Users, sectionKey: "users" },
    ]
  },
  {
    title: "Исполнители",
    items: [`;
    if (content.includes(target) && !content.includes('/users')) {
        content = content.replace(target, replacement);
        fs.writeFileSync(navPath, content, 'utf-8');
        console.log('Fixed navigation.ts!');
    }
}

// 3. Fix TopBar.tsx (Add User Switcher)
const topBarPath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\components\\layout\\TopBar.tsx';
if (fs.existsSync(topBarPath)) {
    let content = fs.readFileSync(topBarPath, 'utf-8');
    const imports = `import { Search, Bell, User } from "lucide-react";\nimport { useState, useEffect } from 'react';\nimport { getUsers, getCurrentUser, login } from '@/lib/users/user-service';`;
    content = content.replace(`import { Search, Bell } from "lucide-react";`, imports);

    const useStates = `
    const [users, setUsers] = useState<any[]>([]);
    const [currentUser, setCurrentUser] = useState<any>(null);

    useEffect(() => {
        getUsers().then(setUsers);
        getCurrentUser().then(setCurrentUser);
    }, []);
    `;
    
    // insert inside TopBar function
    const targetHeader = `export default function TopBar() {`;
    content = content.replace(targetHeader, targetHeader + useStates);

    const replacementGrid = `
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-secondary hover:bg-secondary/80 px-2.5 py-1 rounded-full text-[13px] font-semibold transition-colors">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    <select 
                        value={currentUser?.id || ''} 
                        onChange={async (e) => { 
                            await login(e.target.value); 
                            setCurrentUser(users.find(u => u.id === e.target.value) || null);
                            window.location.reload(); 
                        }} 
                        className="bg-transparent outline-none border-none py-0.5 cursor-pointer text-foreground"
                    >
                        <option value="">Гость</option>
                        {users.map(u => (
                            <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                        ))}
                    </select>
                </div>
                <div className="relative w-48 md:w-64">`;
    content = content.replace(`<div className="flex items-center gap-3">\n                <div className="relative w-48 md:w-64">`, replacementGrid);

    fs.writeFileSync(topBarPath, content, 'utf-8');
    console.log('Fixed TopBar.tsx!');
}
