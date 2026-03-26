const fs = require('fs');
const path1 = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\lib\\users\\user-service.ts';
let content1 = fs.readFileSync(path1, 'utf-8');

if (!content1.includes('deleteUser')) {
    const appendText = `
export async function deleteUser(id: string): Promise<void> {
    const users = await getUsers()
    const filtered = users.filter(u => u.id !== id)
    const filePath = path.join(process.cwd(), 'src/data/users.json')
    await fs.writeFile(filePath, JSON.stringify(filtered, null, 2))
}
`;
    content1 += appendText;
    fs.writeFileSync(path1, content1, 'utf-8');
}

const path2 = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\users\\page.tsx';
let content2 = fs.readFileSync(path2, 'utf-8');

if (!content2.includes('Trash2')) {
    content2 = content2.replace('ToggleRight, User', 'ToggleRight, User, Trash2');
}
if (!content2.includes('deleteUser')) {
    content2 = content2.replace('updateUser, UserItem', 'updateUser, deleteUser, UserItem');
}

const targetHandle = `    const handleToggleStatus = async (user: UserItem) => {
        await updateUser(user.id, { status: user.status === 'Активен' ? 'Отключен' : 'Активен' })
        load()
    }`;

const replacementHandle = `    const handleToggleStatus = async (user: UserItem) => {
        await updateUser(user.id, { status: user.status === 'Активен' ? 'Отключен' : 'Активен' })
        load()
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Вы уверены, что хотите удалить пользователя?')) return
        await deleteUser(id)
        load()
    }`;

if (content2.includes(targetHandle) && !content2.includes('handleDelete')) {
    content2 = content2.replace(targetHandle, replacementHandle);
}

const targetButton = `<button
                                    onClick={() => handleToggleStatus(user)}
                                    className={\`p-1.5 rounded-lg transition-colors \${user.status === 'Активен' ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}\`}
                                >
                                    {user.status === 'Активен' ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
                                </button>`;

const replacementButton = `<button
                                    onClick={() => handleToggleStatus(user)}
                                    className={\`p-1.5 rounded-lg transition-colors \${user.status === 'Активен' ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}\`}
                                    title={user.status === 'Активен' ? 'Отключить' : 'Активировать'}
                                >
                                    {user.status === 'Активен' ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                                </button>
                                <button
                                    onClick={() => handleDelete(user.id)}
                                    className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                                    title="Удалить"
                                >
                                    <Trash2 size={20} />
                                </button>`;

if (content2.includes(targetButton)) {
    content2 = content2.replace(targetButton, replacementButton);
    fs.writeFileSync(path2, content2, 'utf-8');
    console.log('Fixed Delete user flawlessly!');
}
