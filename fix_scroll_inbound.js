const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\messages\\components\\MessageFeed.tsx';

let content = fs.readFileSync(path, 'utf8');

const target2 = `            if (!isOwnMessage) {
                if (atBottom) {
                    // Follow bottom natively
                    if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
                    scrollTimeout.current = setTimeout(() => {
                        virtuoso.current?.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
                    }, 100);
                } else {
                    setShowNewMessagesBadge(true);
                }
            }`;

const replacement2 = `            if (atBottom) {
                // Follow bottom natively
                if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
                scrollTimeout.current = setTimeout(() => {
                    virtuoso.current?.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
                }, 100);
            } else if (!isOwnMessage) {
                setShowNewMessagesBadge(true);
            }`;

let normalized = content.replace(/\r\n/g, '\n');
const t2 = target2.replace(/\r\n/g, '\n');
const r2 = replacement2.replace(/\r\n/g, '\n');

if (normalized.includes(t2)) {
    normalized = normalized.replace(t2, r2);
    fs.writeFileSync(path, normalized.replace(/\n/g, '\r\n'), 'utf8');
    console.log('Success');
} else {
    console.log('Target not found');
}
