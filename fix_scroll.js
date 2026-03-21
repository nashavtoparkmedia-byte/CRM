const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\messages\\components\\MessageFeed.tsx';

let content = fs.readFileSync(path, 'utf8');

const target = `    const scrollTimeout = useRef<NodeJS.Timeout | null>(null)

    // 1. Outbound Scroll Trigger: discrete click event
    useEffect(() => {
        if (!lastSentAt || uiItems.length === 0) return;
        
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        const forceScroll = () => {
            if (virtuoso.current) {
                virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
            }
        };

        // Multiple staggered attempts to absorb virtualization sizing lag above-fold
        setTimeout(forceScroll, 50);
        setTimeout(forceScroll, 200);
        setTimeout(forceScroll, 500);
        
        setShowNewMessagesBadge(false);
    }, [lastSentAt]);`;

const replacement = `    const scrollTimeout = useRef<NodeJS.Timeout | null>(null)
    const previousSentAt = useRef<number>(0)

    // 1. Outbound Scroll Trigger: discrete click event
    useEffect(() => {
        if (!lastSentAt || lastSentAt === previousSentAt.current || uiItems.length === 0) return;
        
        previousSentAt.current = lastSentAt;
        
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        
        const forceScroll = () => {
            if (virtuoso.current) {
                virtuoso.current.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
            }
        };

        setTimeout(forceScroll, 100);
        setTimeout(forceScroll, 300);
        setTimeout(forceScroll, 600);
        
        setShowNewMessagesBadge(false);
    }, [uiItems, lastSentAt]);`;

const normalizedContent = content.replace(/\r\n/g, '\n');
const normalizedTarget = target.replace(/\r\n/g, '\n');
const normalizedReplacement = replacement.replace(/\r\n/g, '\n');

if (normalizedContent.includes(normalizedTarget)) {
    const newContent = normalizedContent.replace(normalizedTarget, normalizedReplacement);
    fs.writeFileSync(path, newContent.replace(/\n/g, '\r\n'), 'utf8');
    console.log('Success');
} else {
    console.log('Target not found');
}
