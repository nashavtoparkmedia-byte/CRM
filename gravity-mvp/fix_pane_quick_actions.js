const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

// 1. Remove Duplicate Buttons syntax crash
content = content.replace(`                        Позвонил
                    </button>
                        Позвонил
                    </button>`, `                        Позвонил
                    </button>`);

content = content.replace(`                        Написал
                    </button>
                        Написал
                    </button>`, `                        Написал
                    </button>`);

// 2. Add Contact row buttons correctly
const contactReplacement = `                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-2 truncate">
                        <User className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-[13px] font-semibold text-gray-900 truncate">{task.driverName}</span>
                        {task.driverPhone && <span className="text-[11px] text-gray-500">+{task.driverPhone}</span>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => window.open(\`tel:\${task.driverPhone}\`, '_self')} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-[11px] text-gray-600 hover:bg-gray-50 transition cursor-pointer">Позвонить</button>
                        <button onClick={() => router.push(\`/messages?msg=new&phone=\${task.driverPhone}&driver=\${task.driverId}\`)} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-[11px] text-gray-600 hover:bg-gray-50 transition cursor-pointer">Написать</button>
                        <button onClick={() => router.push(\`/messages?focusedDriver=\${task.driverId}\`)} className="px-1.5 py-0.5 bg-indigo-50 border border-indigo-100 rounded text-[11px] text-indigo-600 hover:bg-indigo-100 transition cursor-pointer">Чат</button>
                    </div>
                </div>`;

const lines = content.split('\n');
const idx = lines.findIndex(l => l.includes('Однострочный Контакт'));

if (idx !== -1) {
    // find the next div container and replace fully 12 lines
    for (let i = idx; i < lines.length; i++) {
        if (lines[i].includes('<div className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">')) {
            lines.splice(i, 13, contactReplacement); 
            break;
        }
    }
    content = lines.join('\n');
    console.log('Contact row replaced!');
}

// 3. Date format in History
const historyFormatTarget = `<span className="text-[11px] text-[#d1d5db] shrink-0">
                                        {new Date(event.createdAt).toLocaleTimeString('ru-RU', {`;

const historyReplacement = `<span className="text-[11px] text-[#d1d5db] shrink-0">
                                        {new Date(event.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + new Date(event.createdAt).toLocaleTimeString('ru-RU', {`;

if (content.includes(historyFormatTarget)) {
    content = content.replace(historyFormatTarget, historyReplacement);
    console.log('History date format updated!');
}

fs.writeFileSync(path, content, 'utf-8');
console.log('Visual modifications successfully applied!');
