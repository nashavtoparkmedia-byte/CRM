import { Message } from "../hooks/useMessages";

/**
 * PR-З: единая функция для title чата с правильным приоритетом.
 *
 * Анализ проблемы (после PR9.57): formatChatTitle брал источники в
 * порядке driver.fullName → contact.displayName → chat.name. Это
 * сломало WA: для @lid-чатов Contact.displayName хранит FAKE @lid
 * номер (например "+71244690559"), а chat.name хранит РЕАЛЬНЫЙ телефон
 * из WhatsApp pushname (например "+7 908 502-49-02"). В итоге UI
 * показывал fake номер вместо реального.
 *
 * Также для TG/MAX placeholder ". ." / "TG 620303840" — старый код
 * делал fallback на externalChatId → пользователь видел голый
 * internal user ID мессенджера, выглядящий как телефон, но
 * не являющийся им.
 *
 * Новый приоритет:
 *   1. Реальное ИМЯ (содержит буквы, не "TG/MAX NN") — driver.fullName,
 *      затем chat.name (там webhook сохраняет first_name), затем contact
 *   2. Реальный ТЕЛЕФОН — chat.name приоритет (там WA pushname),
 *      contact.displayName ТОЛЬКО если он НЕ совпадает с @lid-digits
 *   3. Phone из externalChatId — только формат @s.whatsapp.net
 *   4. Placeholder — возвращаем "Без имени" (UI показывает badge
 *      «Привязать»), а не голый internal ID
 *
 * Используется в ChatHeader.tsx + ChatList.tsx для consistent
 * отображения по всему UI чатов.
 */
export function formatChatTitle(input: {
    driverFullName?:    string | null
    contactDisplayName?: string | null
    chatName?:          string | null
    externalChatId?:    string | null
}): string {
    const r = formatChatTitleDetailed(input)
    return r.title
}

/**
 * Детальный вариант: возвращает title + флаг isUnlinked для UI badge.
 */
export function formatChatTitleDetailed(input: {
    driverFullName?:    string | null
    contactDisplayName?: string | null
    chatName?:          string | null
    externalChatId?:    string | null
}): { title: string; isUnlinked: boolean } {
    const hasLetters = (s: string) =>
        /[А-Яа-яA-Za-z]/.test(s) && !/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+\d+$/i.test(s.trim())

    const looksLikePhone = (s: string) => {
        const t = s.trim()
        if (!/^\+?[\d\s\-\(\)]{10,20}$/.test(t)) return false
        const digits = t.replace(/\D/g, '')
        return digits.length >= 10 && digits.length <= 15
    }

    // Проверяет, совпадает ли value с @lid-digits из externalChatId.
    // Для WA: externalChatId = "69501244690559@lid" → @lid digits = "69501244690559".
    // contact.displayName = "+71244690559" → digits = "71244690559" — совпадает
    // с хвостом @lid → значит fake.
    const isFakeLid = (value: string, extId?: string | null) => {
        if (!extId) return false
        const m = extId.match(/^(?:whatsapp:)?(\d{10,15})(?:@lid)?$/)
        if (!m) return false
        const lidDigits = m[1]
        const valDigits = value.replace(/\D/g, '')
        return lidDigits.includes(valDigits) || valDigits.includes(lidDigits)
    }

    // === 1. Реальное ИМЯ (с буквами) ===
    if (input.driverFullName && hasLetters(input.driverFullName)) {
        return { title: input.driverFullName.trim(), isUnlinked: false }
    }
    if (input.chatName && hasLetters(input.chatName)) {
        return {
            title: input.chatName.replace(/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+/i, '').trim(),
            isUnlinked: false,
        }
    }
    if (input.contactDisplayName && hasLetters(input.contactDisplayName)) {
        return { title: input.contactDisplayName.trim(), isUnlinked: false }
    }

    // === 2. Реальный ТЕЛЕФОН ===
    // chat.name приоритет — туда WA-скрапер пишет pushname, MAX — phone из
    // первого inbound, TG-bot — username/phone.
    if (input.chatName && looksLikePhone(input.chatName)) {
        return { title: input.chatName.trim(), isUnlinked: false }
    }
    // Contact только если НЕ fake @lid
    if (input.contactDisplayName
        && looksLikePhone(input.contactDisplayName)
        && !isFakeLid(input.contactDisplayName, input.externalChatId)) {
        return { title: input.contactDisplayName.trim(), isUnlinked: false }
    }

    // === 3. Phone из externalChatId — только если реальный формат ===
    // WA: только @s.whatsapp.net
    const waMatch = (input.externalChatId ?? '').match(/(\d{10,15})@s\.whatsapp\.net/)
    if (waMatch) return { title: `+${waMatch[1]}`, isUnlinked: false }

    // === 4. Placeholder — показываем «Без имени», UI добавит badge ===
    return { title: 'Без имени', isUnlinked: true }
}

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
