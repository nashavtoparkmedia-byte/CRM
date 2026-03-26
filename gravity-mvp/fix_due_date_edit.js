const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const target = `                    <MetaField label="Срок" icon={<Clock className="w-3.5 h-3.5" />}>
                        <span className={\`text-[13px] \${isOverdue ? 'text-red-500 font-semibold' : ''}\`}>
                            {task.dueAt
                                ? new Date(task.dueAt).toLocaleDateString('ru-RU', {
                                    day: 'numeric',
                                    month: 'short',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })
                                : '—'
                            }
                        </span>
                    </MetaField>`;

const replacement = `                    <MetaField label="Срок" icon={<Clock className="w-3.5 h-3.5 \${isOverdue ? 'text-red-500' : ''}" />}>
                        <input
                            type="datetime-local"
                            value={task.dueAt ? new Date(new Date(task.dueAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                            disabled={['done', 'cancelled', 'archived'].includes(task.status)}
                            onChange={(e) => {
                                const val = e.target.value;
                                updateTask.mutate({ id: task.id, patch: { dueAt: val ? new Date(val).toISOString() : null } })
                            }}
                            className={\`bg-transparent outline-none rounded text-[13px] font-semibold cursor-pointer -ml-1 py-0.5 border border-transparent hover:border-gray-200 transition-colors \${
                                isOverdue ? 'text-red-600 font-bold' : !task.dueAt ? 'bg-yellow-50 border-yellow-200 text-yellow-800 px-1' : 'text-[#1f2937]'
                            }\`}
                        />
                    </MetaField>`;

if (content.includes(`span className={\`text-[13px]`)) {
    // split by line mapping to securely replace fully
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.includes('label="Срок"'));
    if (idx !== -1) {
        lines.splice(idx, 13, replacement); // Replace fully with standard element input container index mapping
        content = lines.join('\n');
    }
} else if (content.includes(target)) {
    content = content.replace(target, replacement);
}

// Expand Quick Actions Row
const quickActionsTarget = `                    <button
                        onClick={() => {
                            const current = task.dueAt ? new Date(task.dueAt) : new Date()
                            current.setDate(current.getDate() + 1)
                            updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } })
                        }}
                        className="text-[11px] px-1.5 py-0.5 bg-blue-50 border border-blue-100 hover:bg-blue-100 rounded text-blue-700 transition cursor-pointer"
                    >
                        Срок +1д.
                    </button>`;

const quickActionsReplacement = `                    <button
                        onClick={() => {
                            const current = task.dueAt ? new Date(task.dueAt) : new Date();
                            current.setHours(current.getHours() + 1);
                            updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } });
                        }}
                        className="text-[11px] px-1.5 py-0.5 bg-gray-50 border border-gray-200 hover:bg-gray-100 rounded text-gray-700 transition cursor-pointer"
                    >
                        +1ч
                    </button>
                    <button
                        onClick={() => {
                            const current = task.dueAt ? new Date(task.dueAt) : new Date();
                            current.setDate(current.getDate() + 1);
                            updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } });
                        }}
                        className="text-[11px] px-1.5 py-0.5 bg-blue-50 border border-blue-100 hover:bg-blue-100 rounded text-blue-700 transition cursor-pointer"
                    >
                        +1д
                    </button>
                    <button
                        onClick={() => {
                            const current = task.dueAt ? new Date(task.dueAt) : new Date();
                            current.setDate(current.getDate() + 3);
                            updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } });
                        }}
                        className="text-[11px] px-1.5 py-0.5 bg-gray-50 border border-gray-200 hover:bg-gray-100 rounded text-gray-700 transition cursor-pointer"
                    >
                        +3д
                    </button>`;

if (content.includes(`const current = task.dueAt ? new Date(task.dueAt) : new Date()`)) {
    content = content.replace(quickActionsTarget, quickActionsReplacement);
}

fs.writeFileSync(path, content, 'utf-8');
console.log('Due Date editing successfully implemented with native elements triggers!');
