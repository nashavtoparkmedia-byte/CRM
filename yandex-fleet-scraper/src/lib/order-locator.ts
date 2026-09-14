export interface OrderRowLinkSnapshot {
    text: string;
    href: string;
}

export interface OrderRowSnapshot {
    text: string;
    links: OrderRowLinkSnapshot[];
}

export interface LocatedOrder {
    shortOrderId: string;
    orderHref: string;
    orderLongId: string | null;
    rowText: string;
}

export interface ObservedOrder {
    shortOrderId: string;
    orderLongId: string | null;
    terminal: boolean;
    rowText: string;
}

export interface OrderTableScan {
    activeOrder: LocatedOrder | null;
    observedOrders: ObservedOrder[];
}

const TERMINAL_STATUS = /Выполнен|Отменён|Отменен/i;
const HEADER_ROW = /^\s*(Статус|Код заказа|Исполнитель)/i;

/**
 * Extract the order identifier from Fleet links without assuming that it is
 * hexadecimal. Delivery orders use identifiers such as `cargo_<hex>`.
 */
export function extractFleetOrderId(href: string): string | null {
    try {
        const url = new URL(href, 'https://fleet.yandex.ru');
        const match = url.pathname.match(/\/orders\/([^/?#]+)/i);
        return match?.[1] ? decodeURIComponent(match[1]) : null;
    } catch {
        return null;
    }
}

/**
 * Find the topmost non-terminal order row. The href is the stable contract;
 * the visible code may contain any number of digits (cargo codes can be five
 * digits, while taxi codes are commonly seven digits).
 */
export function scanFleetOrderRows(rows: OrderRowSnapshot[]): OrderTableScan {
    const observedOrders: ObservedOrder[] = [];
    let activeOrder: LocatedOrder | null = null;

    for (const row of rows) {
        const text = row.text || '';
        if (HEADER_ROW.test(text)) continue;

        const orderLink = row.links.find(link => {
            const shortCode = (link.text || '').trim();
            return /^\d+$/.test(shortCode) && extractFleetOrderId(link.href) !== null;
        });
        if (!orderLink) continue;

        const shortOrderId = orderLink.text.trim();
        const orderLongId = extractFleetOrderId(orderLink.href);
        const terminal = TERMINAL_STATUS.test(text);
        const rowText = text.trim().replace(/\s+/g, ' ').slice(0, 300);

        observedOrders.push({ shortOrderId, orderLongId, terminal, rowText });
        if (!terminal && !activeOrder) {
            activeOrder = {
                shortOrderId,
                orderHref: orderLink.href,
                orderLongId,
                rowText: rowText.slice(0, 200),
            };
        }
    }

    return { activeOrder, observedOrders: observedOrders.slice(0, 10) };
}
