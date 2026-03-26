const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\components\\layout\\TopBar.tsx';
let content = fs.readFileSync(path, 'utf-8');

// 1. Add LogOut to imports if not there
if (content.includes('Search, Bell, User')) {
    content = content.replace('Search, Bell, User', 'Search, Bell, User, LogOut');
}
if (!content.includes('logout')) {
    content = content.replace('getCurrentUser, login', 'getCurrentUser, login, logout');
}

// 2. Add Button after select/span
const target = `) : (
                        <span className="text-foreground text-[12px]">{currentUser.firstName} {currentUser.lastName}</span>
                    )}`;

const replacement = `) : (
                        <span className="text-foreground text-[12px]">{currentUser.firstName} {currentUser.lastName}</span>
                    )}
                    {currentUser && (
                        <button 
                            onClick={async () => {
                                const { logout } = await import('@/lib/users/user-service');
                                await logout();
                                window.location.href = '/login';
                            }}
                            className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors ml-1 cursor-pointer"
                            title="Выйти"
                        >
                            <LogOut className="h-3.5 w-3.5" />
                        </button>
                    )}`;

if (content.includes(target) && !content.includes('Выйти')) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Fixed TopBar Logout successfully!');
} else {
    console.log('Target TopBar select structure for Logout not found!');
}
