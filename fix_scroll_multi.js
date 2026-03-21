const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\messages\\components\\MessageFeed.tsx';

let content = fs.readFileSync(path, 'utf8');

const target1 = `    // 1. Outbound Scroll Trigger: discrete click event
    useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
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
                virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
            }
            attempts++;
            if (attempts > 3) clearInterval(scrollInterval);
        }, 150);

        setShowNewMessagesBadge(false);
        return () => clearInterval(scrollInterval);
    }, [uiItems, lastSentAt]);`;

const target2 = `    // 2. Inbound Scroll Trigger: new items append
    useEffect(() => {
        if (uiItems.length === 0) return;
        const lastItem = uiItems[uiItems.length - 1];
        if (lastItem.type !== 'message') return;

        const msgId = lastItem.message.id;
        const isNew = !seenMessageIds.current.has(msgId);
        
        if (isNew) {
            seenMessageIds.current.add(msgId);
            const isOwnMessage = lastItem.message.direction === 'outbound';
            
            if (!isOwnMessage) {
                if (atBottom) {
                    // Follow bottom natively
                    if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
                    scrollTimeout.current = setTimeout(() => {
                        virtuoso.current?.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
                    }, 100);
                } else {
                    setShowNewMessagesBadge(true);
                }
            }
        }
    }, [uiItems, atBottom]);`;

const replacement2 = `    // 2. Inbound/Update Scroll Trigger: new items append
    useEffect(() => {
        if (uiItems.length === 0) return;
        const lastItem = uiItems[uiItems.length - 1];
        if (lastItem.type !== 'message') return;

        const msgId = lastItem.message.id;
        const isNew = !seenMessageIds.current.has(msgId);
        
        if (isNew) {
            seenMessageIds.current.add(msgId);
            const isOwnMessage = lastItem.message.direction === 'outbound';
            
            if (atBottom) {
                if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
                scrollTimeout.current = setTimeout(() => {
                    virtuoso.current?.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
                }, 100);
            } else if (!isOwnMessage) {
                setShowNewMessagesBadge(true);
            }
        }
    }, [uiItems, atBottom]);`;

let normalized = content.replace(/\r\n/g, '\n');
const t1 = target1.replace(/\r\n/g, '\n');
const r1 = replacement1.replace(/\r\n/g, '\n');
const t2 = target2.replace(/\r\n/g, '\n');
const r2 = replacement2.replace(/\r\n/g, '\n');

if (normalized.includes(t1) && normalized.includes(t2)) {
    normalized = normalized.replace(t1, r1).replace(t2, r2);
    fs.writeFileSync(path, normalized.replace(/\n/g, '\r\n'), 'utf8');
    console.log('Success');
} else {
    console.log('Targets not found');
    console.log('T1 found:', normalized.includes(t1));
    console.log('T2 found:', normalized.includes(t2));
}
