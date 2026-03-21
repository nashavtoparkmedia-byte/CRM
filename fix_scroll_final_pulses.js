const fs = require('fs');
const path = 'c:\\\\Users\\\\mixx\\\\Documents\\\\Github\\\\CRM\\\\gravity-mvp\\\\src\\\\app\\\\messages\\\\components\\\\MessageFeed.tsx';

try {
    let content = fs.readFileSync(path, 'utf8');

    const target1 = `    // 1. Outbound Scroll Trigger: discrete click event
    useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
        previousSentAt.current = lastSentAt;
        
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        const forceScroll = () => {
            if (virtuoso.current) {
                virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
            }
        };

        // Multiple staggered attempts to absorb virtualization sizing lag above-fold
        setTimeout(forceScroll, 100);
        setTimeout(forceScroll, 300);
        setTimeout(forceScroll, 600);
        
        setShowNewMessagesBadge(false);
    }, [uiItems, lastSentAt]);`;

    const replacement1 = `    // 1. Outbound Scroll Trigger: discrete click event
    useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
        previousSentAt.current = lastSentAt; // consume trigger
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        let attempts = 0;
        const scrollInterval = setInterval(() => {
            if (virtuoso.current) {
                // Absolute scroll + Index alignment to absorb sizing shifts
                virtuoso.current.scrollTo({ top: 10000000, behavior: 'auto' });
                virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
            }
            attempts++;
            if (attempts > 3) clearInterval(scrollInterval);
        }, 150);

        setShowNewMessagesBadge(false);
        return () => clearInterval(scrollInterval);
    }, [uiItems, lastSentAt]);`;

    let normalized = content.replace(/\r\n/g, '\n');
    const t1 = target1.replace(/\r\n/g, '\n');
    const r1 = replacement1.replace(/\r\n/g, '\n');

    if (normalized.includes(t1)) {
        normalized = normalized.replace(t1, r1);
        fs.writeFileSync(path, normalized.replace(/\n/g, '\r\n'), 'utf8');
        console.log('Success');
    } else {
        console.log('Target not found');
        process.exit(1);
    }
} catch (e) {
    console.log('Crash error:', e.message);
    process.exit(1);
}
