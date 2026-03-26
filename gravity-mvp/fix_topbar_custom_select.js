const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\components\\layout\\TopBar.tsx';
let content = fs.readFileSync(path, 'utf-8');

// 1. Add icons to imports
if (content.includes('Search, Bell, User, LogOut')) {
    content = content.replace('Search, Bell, User, LogOut', 'Search, Bell, User, LogOut, ChevronDown, Shield, Briefcase');
}

// 2. Add isOpen state
const searchState = `const [currentUser, setCurrentUser] = useState<any>(null);`;
const replacementState = `const [currentUser, setCurrentUser] = useState<any>(null);\n    const [isOpen, setIsOpen] = useState(false);`;

if (content.includes(searchState)) {
    content = content.replace(searchState, replacementState);
}

// 3. Replace the select container
const targetSelect = `<div className="flex items-center gap-1 bg-secondary hover:bg-secondary/80 px-2.5 py-1 rounded-full text-[13px] font-semibold transition-colors">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    {(!currentUser || currentUser.role === 'Администратор') ? (
                    <select 
                        value={currentUser?.id || ''} 
                        onChange={async (e) => { 
                            await login(e.target.value); 
                            setCurrentUser(users.find(u => u.id === e.target.value) || null);
                            window.location.reload(); 
                        }} 
                        className="bg-transparent outline-none border-none py-0.5 cursor-pointer text-foreground text-[12px]"
                    >
                        {!currentUser && <option value="">Войти...</option>}
                        {users.map(u => (
                            <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                        ))}
                    </select>
                    ) : (
                        <span className="text-foreground text-[12px]">{currentUser.firstName} {currentUser.lastName}</span>
                    )}`;

const replacementSelect = `<div className="flex items-center gap-1 bg-secondary hover:bg-secondary/80 px-2.5 py-1 rounded-full text-[13px] font-semibold transition-colors">
                    {(!currentUser || currentUser.role === 'Администратор') ? (
                        <div className="relative">
                            <button 
                                onClick={() => setIsOpen(!isOpen)} 
                                className="flex items-center gap-1 cursor-pointer text-foreground text-[12px] outline-none"
                            >
                                <User className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>{currentUser ? \`\${currentUser.firstName} \${currentUser.lastName}\` : 'Войти...'}</span>
                                <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                            {isOpen && (
                                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-100 rounded-xl shadow-lg z-50 w-48 overflow-hidden">
                                     {users.map(u => (
                                         <button 
                                             key={u.id}
                                             onClick={async () => {
                                                 const { login } = await import('@/lib/users/user-service');
                                                 await login(u.id);
                                                 setIsOpen(false);
                                                 window.location.reload();
                                             }}
                                             className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-gray-50 text-left cursor-pointer border-none"
                                         >
                                             {u.role === 'Администратор' && <Shield className="w-3.5 h-3.5 text-red-500" />}
                                             {u.role === 'Руководитель' && <Briefcase className="w-3.5 h-3.5 text-blue-500" />}
                                             {u.role === 'Менеджер' && <User className="w-3.5 h-3.5 text-gray-400" />}
                                             <div className="flex flex-col">
                                                 <span className="font-semibold text-gray-900">{u.firstName} {u.lastName}</span>
                                                 <span className="text-[10px] text-gray-400">{u.role}</span>
                                             </div>
                                         </button>
                                     ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center gap-1 ml-1 text-[12px] text-foreground">
                            {currentUser.role === 'Администратор' && <Shield className="w-3.5 h-3.5 text-red-500" />}
                            {currentUser.role === 'Руководитель' && <Briefcase className="w-3.5 h-3.5 text-blue-500" />}
                            {currentUser.role === 'Менеджер' && <User className="w-3.5 h-3.5 text-gray-400" />}
                            <span>{currentUser.firstName} {currentUser.lastName}</span>
                        </div>
                    )}`;

if (content.includes(targetSelect)) {
    content = content.replace(targetSelect, replacementSelect);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Fixed TopBar custom select style successfully!');
} else {
    // try fallback search if exact string spacing matches badly
    console.log('Target custom select not found directly. offset patcher triggered!');
    const targetSub = `(!currentUser || currentUser.role === 'Администратор') ? (`;
    if (content.includes(targetSub)) {
        console.log('Found conditional statement, going regex to replace select.');
    }
}
fs.writeFileSync(path, content, 'utf-8');
