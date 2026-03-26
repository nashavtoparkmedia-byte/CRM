const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(path, 'utf-8');

const target = `{event.payload && (event.payload as any).from && (
                                            <span className="text-[#9ca3af]">
                                                {' '}→ {STATUS_LABELS[(event.payload as any).to] ?? (event.payload as any).to}
                                            </span>
                                        )}`;

const replacement = `{event.payload && (event.payload as any).from && (
                                            <span className="text-[#6b7280] text-[11px] block mt-0.5">
                                                {event.eventType === 'postponed' ? (
                                                    \`с \${new Date((event.payload as any).from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, \${new Date((event.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} на \${new Date((event.payload as any).to).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, \${new Date((event.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}\`
                                                ) : (
                                                    \`с \${STATUS_LABELS[(event.payload as any).from] || (event.payload as any).from} на \${STATUS_LABELS[(event.payload as any).to] || (event.payload as any).to}\`
                                                )}
                                            </span>
                                        )}`;

if (content.includes(`{event.payload && (event.payload as any).from && (`)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Postponed log pretty print formatted!');
} else {
    console.log('Target for postponed format not found!');
}
