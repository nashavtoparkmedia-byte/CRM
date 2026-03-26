const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\components\\layout\\TopBar.tsx';
let content = fs.readFileSync(path, 'utf-8');

const targetSelect = `<select 
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
                    </select>`;

const replacementSelect = `{(!currentUser || currentUser.role === 'Администратор') ? (
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

if (content.includes(targetSelect)) {
    content = content.replace(targetSelect, replacementSelect);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Fixed TopBar RBAC successfully!');
} else {
    console.log('Target select not found for RBAC!');
}
