const fs = require('fs');

const targetPath = 'c:\\\\Users\\\\mixx\\\\Documents\\\\Github\\\\CRM\\\\gravity-mvp\\\\src\\\\app\\\\messages\\\\components\\\\MessageFeed.tsx';

try {
    let content = fs.readFileSync(targetPath, 'utf8');
    const normalized = content.replace(/\r/g, '');

    const t1_regex = /useEffect\(\(\) => \{\s*if \(!lastSentAt \|\| lastSentAt === previousSentAt\.current \|\| uiItems\.length === 0\) return;[\s\S]*?setShowNewMessagesBadge\(false\);\s*\}, \[lastSentAt\]\);/;
    
    const r1 = `useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
        previousSentAt.current = lastSentAt; // consume trigger
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        let attempts = 0;
        const scrollInterval = setInterval(() => {
            if (virtuoso.current) {
                virtuoso.current.scrollTo({ top: 10000000, behavior: 'auto' });
                virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
            }
            attempts++;
            if (attempts > 3) clearInterval(scrollInterval);
        }, 150);

        setShowNewMessagesBadge(false);
        return () => clearInterval(scrollInterval);
    }, [uiItems, lastSentAt]);`;

    if (t1_regex.test(normalized)) {
        const updated = normalized.replace(t1_regex, r1);
        fs.writeFileSync(targetPath, updated.replace(/\n/g, '\r\n'), 'utf8');
        console.log('Success: T1 Replaced');
    } else {
        console.log('T1 not found with Regex!');
        const lines = normalized.split('\n');
        console.log('Line 44-65 excerpt:');
        console.log(lines.slice(43, 65).join('\n'));
    }
} catch (e) {
    console.error('Error:', e.message);
}
