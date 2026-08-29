import { extractFleetOrderId, scanFleetOrderRows } from '../src/lib/order-locator.js';

describe('Fleet active-order locator', () => {
    test('finds a regular seven-digit taxi order', () => {
        const result = scanFleetOrderRows([{
            text: 'Ждёт клиента 3837967 3 авг.',
            links: [{
                text: '3837967',
                href: 'https://fleet.yandex.ru/orders/f5cd45c67fda895fb52be941b39003c6?park_id=park',
            }],
        }]);

        expect(result.activeOrder).toMatchObject({
            shortOrderId: '3837967',
            orderLongId: 'f5cd45c67fda895fb52be941b39003c6',
        });
    });

    test('finds a five-digit delivery order with cargo-prefixed id', () => {
        const result = scanFleetOrderRows([{
            text: 'На заказе 30788 Volkswagen Polo',
            links: [{
                text: '30788',
                href: 'https://fleet.yandex.ru/orders/cargo_7d8eed4b6bb5c59ed6764fbb43?park_id=delivery',
            }],
        }]);

        expect(result.activeOrder).toMatchObject({
            shortOrderId: '30788',
            orderLongId: 'cargo_7d8eed4b6bb5c59ed6764fbb43',
        });
    });

    test('ignores terminal orders but preserves them in diagnostics', () => {
        const result = scanFleetOrderRows([{
            text: 'Выполнен 30788 Volkswagen Polo',
            links: [{ text: '30788', href: '/orders/cargo_7d8eed4b6bb5c59ed6764fbb43' }],
        }]);

        expect(result.activeOrder).toBeNull();
        expect(result.observedOrders).toEqual([expect.objectContaining({
            shortOrderId: '30788',
            terminal: true,
        })]);
    });

    test('does not treat unrelated numeric links as orders', () => {
        const result = scanFleetOrderRows([{
            text: 'Телефон 30788',
            links: [{ text: '30788', href: '/contractors/30788' }],
        }]);

        expect(result.activeOrder).toBeNull();
        expect(result.observedOrders).toHaveLength(0);
    });

    test('extracts order ids from absolute and relative Fleet links', () => {
        expect(extractFleetOrderId('/orders/cargo_abc123?park_id=x')).toBe('cargo_abc123');
        expect(extractFleetOrderId('https://fleet.yandex.ru/orders/abcdef123456/map')).toBe('abcdef123456');
        expect(extractFleetOrderId('/contractors/123/orders')).toBeNull();
    });
});
