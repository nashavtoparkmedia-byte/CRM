const fs = require('fs');
const path = 'c:\\\\Users\\\\mixx\\\\Documents\\\\Github\\\\CRM\\\\gravity-mvp\\\\src\\\\app\\\\messages\\\\components\\\\MessageFeed.tsx';

try {
    const content = fs.readFileSync(path, 'utf8');
    const normalized = content.replace(/\r/g, '');

    const startMarker = '// 1. Outbound Scroll Trigger';
    const endMarker = '// 2. Inbound Scroll Trigger';

    const startIndex = normalized.indexOf(startMarker);
    const endIndex = normalized.indexOf(endMarker);

    if (startIndex !== -1 && endIndex !== -1) {
        const pre = normalized.substring(0, startIndex);
        const post = normalized.substring(endIndex);

        const r1 = `// 1. Outbound Scroll Trigger: discrete click event
    useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
        previousSentAt.current = lastSentAt; // consume trigger
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        if (virtuoso.current) {
            virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'smooth' });
        }

        setShowNewMessagesBadge(false);
    }, [uiItems, lastSentAt]);

    `;

        const updated = pre + r1 + post;
        fs.writeFileSync(path, updated.replace(/\n/g, '\r\n'), 'utf8');
        console.log('Success: Multi-Replace succeeded');
    } else {
        console.log('Markers not found. Start:', startIndex, 'End:', endIndex);
    }
} catch (e) {
    console.error('Error:', e.message);
}
