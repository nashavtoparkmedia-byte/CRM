const fs = require('fs');

const targetPath = 'c:\\\\Users\\\\mixx\\\\Documents\\\\Github\\\\CRM\\\\gravity-mvp\\\\src\\\\app\\\\messages\\\\components\\\\MessageFeed.tsx';

try {
    let content = fs.readFileSync(targetPath, 'utf8');
    const normalized = content.replace(/\r/g, '');

    const t1_regex = /useEffect\(\(\) => \{\s*if \(!lastSentAt \|\| lastSentAt === previousSentAt\.current \|\| uiItems\.length === 0\) return;[\s\S]*?setShowNewMessagesBadge\(false\);\s*return \(\) => clearInterval\(scrollInterval\);\s*\}, \[uiItems, lastSentAt\]\);/;
    
    const r1 = `useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
        previousSentAt.current = lastSentAt; // consume trigger
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        if (virtuoso.current) {
            virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'smooth' });
        }

        setShowNewMessagesBadge(false);
    }, [uiItems, lastSentAt]);`;

    if (t1_regex.test(normalized)) {
        const updated = normalized.replace(t1_regex, r1);
        fs.writeFileSync(targetPath, updated.replace(/\n/g, '\r\n'), 'utf8');
        console.log('Success: T1 Replaced with Smooth');
    } else {
        console.log('T1 not found with Regex with clean returns');
        const lines = normalized.split('\n');
        console.log('Snippet 44-65:');
        console.log(lines.slice(43, 65).join('\n'));
    }
} catch (e) {
    console.error('Error:', e.message);
}
