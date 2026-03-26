const fs = require('fs');
const filePath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\users\\page.tsx';
let content = fs.readFileSync(filePath, 'utf-8');

if (!content.includes('getCurrentUser')) {
    content = content.replace(`import { getUsers, addUser, updateUser, UserItem } from '@/lib/users/user-service'`, `import { getUsers, addUser, updateUser, UserItem, getCurrentUser } from '@/lib/users/user-service'`);
}

const targetState = `    const [users, setUsers] = useState<UserItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isAddOpen, setIsAddOpen] = useState(false)`;

const replacementState = `    const [users, setUsers] = useState<UserItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isAddOpen, setIsAddOpen] = useState(false)
    const [currentUser, setCurrentUser] = useState<any>(null)`;

if (content.includes(targetState)) {
    content = content.replace(targetState, replacementState);
}

const targetEffect = `    useEffect(() => {
        load()
    }, [])`;

const replacementEffect = `    useEffect(() => {
        getCurrentUser().then(setCurrentUser)
        load()
    }, [])`;

if (content.includes(targetEffect)) {
    content = content.replace(targetEffect, replacementEffect);
}

const targetBlock = `if (isLoading && users.length === 0) return <div className="p-8 text-center text-gray-500">Загрузка пользователей...</div>`;
const replacementBlock = `if (isLoading && users.length === 0) return <div className="p-8 text-center text-gray-500">Загрузка пользователей...</div>

    if (currentUser && currentUser.role === 'Менеджер') {
        return (
            <PageContainer>
                <div className="p-8 text-center text-red-500 font-bold bg-red-50 rounded-xl border border-red-200 mt-6 shadow-sm">
                    Доступ запрещен. Настройка пользователей разрешена только Администраторам и Руководителям.
                </div>
            </PageContainer>
        )
    }`;

if (content.includes(targetBlock)) {
    content = content.replace(targetBlock, replacementBlock);
}

fs.writeFileSync(filePath, content, 'utf-8');
console.log('Fixed Users RBAC successfully!');
