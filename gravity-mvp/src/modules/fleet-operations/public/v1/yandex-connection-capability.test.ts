import { describe, expect, it } from 'vitest'

import {
    dedupeYandexConnectionCredentialsV1,
    type YandexConnectionCredentialsV1,
} from './yandex-connection-capability'

const connection = (overrides: Partial<YandexConnectionCredentialsV1> = {}): YandexConnectionCredentialsV1 => ({
    connectionId: 'connection-a',
    localParkId: null,
    clid: 'clid-a',
    apiKey: 'key-a',
    parkId: 'park-a',
    name: 'Yoko',
    ...overrides,
})

describe('Yandex connection capability', () => {
    it('removes exact duplicate legacy credentials without merging distinct credentials', () => {
        expect(dedupeYandexConnectionCredentialsV1([
            connection(),
            connection({ connectionId: 'connection-duplicate', name: 'Наш Автопарк' }),
            connection({ connectionId: 'connection-different-key', apiKey: 'key-b' }),
        ])).toEqual([
            connection(),
            connection({ connectionId: 'connection-different-key', apiKey: 'key-b' }),
        ])
    })
})
