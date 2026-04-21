import { Message } from "../hooks/useMessages";

export type MessageUIPosition = 'single' | 'start' | 'middle' | 'end';
export type StatusPlacement = 'inline' | 'overlay';

export interface MessageUIItem {
    type: 'message';
    key: string;
    message: Message;
    groupId: string;
    position: MessageUIPosition;
    showAvatar: boolean;
    showName: boolean;
    showTail: boolean;
    spacingTop: number;
    statusPlacement: StatusPlacement;
}

export interface DateSeparatorUIItem {
    type: 'date_separator';
    key: string;
    label: string;
    date: string; // ISO date string
}

export type UIItem = MessageUIItem | DateSeparatorUIItem;

// Spacing constants as requested
export const SPACING = {
    IN_GROUP: 2,
    BETWEEN_GROUPS: 10,
    AFTER_SEPARATOR: 12,
};

/**
 * Pure function to prepare raw messages for the UI.
 * Handles grouping, date separators, and visual metadata.
 */
export function prepareMessagesForUI(messages: Message[]): UIItem[] {
    if (!messages || messages.length === 0) return [];

    const items: UIItem[] = [];
    
    // Sort messages by sentAt ASC if not already (backend returns ASC reversed, so they should be ASC)
    // Actually MessageService.listMessages returns serialize(messages.reverse()) where original was sentAt: 'desc'
    // So the input is already ASC.
    
    let lastDateLabel: string | null = null;
    let currentGroupId: string | null = null;
    
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const nextMsg = messages[i + 1];
        const prevMsg = messages[i - 1];
        
        const msgDate = new Date(msg.sentAt);
        const dateLabel = getDateLabel(msgDate);
        
        // 1. Check for Date Separator
        if (dateLabel !== lastDateLabel) {
            items.push({
                type: 'date_separator',
                key: `sep-${msg.sentAt}-${i}`,
                label: dateLabel,
                date: msg.sentAt
            });
            lastDateLabel = dateLabel;
            currentGroupId = null; // Break group on date change
        }
        
        // 2. Grouping Logic
        // Same visual side = same direction AND (effectively) same sender context
        // Strict rules: consecutive, same author/direction, <= 5 min difference
        
        // Call messages are always standalone — never grouped with adjacent messages
        const isCallMsg = msg.type === 'call'
        const prevIsCall = prevMsg?.type === 'call'
        const nextIsCall = nextMsg?.type === 'call'

        const isSameSideAsPrev = !isCallMsg && !prevIsCall && prevMsg &&
            prevMsg.direction === msg.direction &&
            prevMsg.origin === msg.origin &&
            (new Date(msg.sentAt).getTime() - new Date(prevMsg.sentAt).getTime()) <= 5 * 60 * 1000 &&
            getDateLabel(new Date(prevMsg.sentAt)) === dateLabel;

        const isSameSideAsNext = !isCallMsg && !nextIsCall && nextMsg &&
            nextMsg.direction === msg.direction &&
            nextMsg.origin === msg.origin &&
            (new Date(nextMsg.sentAt).getTime() - new Date(msg.sentAt).getTime()) <= 5 * 60 * 1000 &&
            getDateLabel(new Date(nextMsg.sentAt)) === dateLabel;

        // Determine position in group
        let position: MessageUIPosition = 'single';
        if (isSameSideAsPrev && isSameSideAsNext) {
            position = 'middle';
        } else if (isSameSideAsPrev && !isSameSideAsNext) {
            position = 'end';
        } else if (!isSameSideAsPrev && isSameSideAsNext) {
            position = 'start';
        }
        
        if (position === 'start' || position === 'single') {
            currentGroupId = `group-${msg.id}`;
        }

        // 3. UI Metadata per message
        const showAvatar = msg.direction === 'inbound' && (position === 'start' || position === 'single');
        const showName = msg.direction === 'inbound' && (position === 'start' || position === 'single');
        const showTail = position === 'end' || position === 'single';
        
        const spacingTop = items[items.length - 1]?.type === 'date_separator' 
            ? SPACING.AFTER_SEPARATOR 
            : (position === 'start' || position === 'single' ? SPACING.BETWEEN_GROUPS : SPACING.IN_GROUP);

        // statusPlacement Logic: overlay if text length <= 15 or media
        const statusPlacement: StatusPlacement = (msg.type === 'image' || msg.content.length <= 15) ? 'overlay' : 'inline';

        items.push({
            type: 'message',
            key: msg.id,
            message: msg,
            groupId: currentGroupId || `group-${msg.id}`,
            position,
            showAvatar,
            showName,
            showTail,
            spacingTop,
            statusPlacement
        });
    }

    return items;
}

/**
 * Helper to get a human-readable date label (Russian).
 */
function getDateLabel(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    if (d.getTime() === today.getTime()) return 'Сегодня';
    if (d.getTime() === yesterday.getTime()) return 'Вчера';
    
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}
