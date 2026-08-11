import { describe, expect, test } from 'vitest'

import {
    callStatusColor,
    callStatusIcon,
    callStatusLabel,
    type CallDirection,
    type CallStatusValue,
} from './call-status-policy'

const statuses: CallStatusValue[] = [
    'ringing',
    'active',
    'completed',
    'missed',
    'no_answer',
    'busy',
    'rejected',
    'cancelled',
    'failed',
]
const directions: CallDirection[] = ['inbound', 'outbound']

describe('Calling call status public policy', () => {
    test('preserves the complete label, color, and icon matrix consumed by Messages', () => {
        const matrix = Object.fromEntries(directions.flatMap((direction) => statuses.map((status) => [
            `${direction}:${status}`,
            {
                label: callStatusLabel(direction, status, null),
                color: callStatusColor(direction, status),
                icon: callStatusIcon(direction, status),
            },
        ])))

        expect(matrix).toMatchInlineSnapshot(`
          {
            "inbound:active": {
              "color": "green",
              "icon": "incoming",
              "label": "Входящий, идёт разговор",
            },
            "inbound:busy": {
              "color": "red",
              "icon": "missed",
              "label": "Линия занята",
            },
            "inbound:cancelled": {
              "color": "gray",
              "icon": "missed",
              "label": "Пропущенный звонок",
            },
            "inbound:completed": {
              "color": "green",
              "icon": "incoming",
              "label": "Входящий",
            },
            "inbound:failed": {
              "color": "gray",
              "icon": "failed",
              "label": "Не удалось",
            },
            "inbound:missed": {
              "color": "red",
              "icon": "missed",
              "label": "Пропущенный звонок",
            },
            "inbound:no_answer": {
              "color": "red",
              "icon": "missed",
              "label": "Пропущенный звонок",
            },
            "inbound:rejected": {
              "color": "gray",
              "icon": "missed",
              "label": "Отклонён",
            },
            "inbound:ringing": {
              "color": "green",
              "icon": "incoming",
              "label": "Входящий вызов",
            },
            "outbound:active": {
              "color": "green",
              "icon": "outgoing",
              "label": "Исходящий, идёт разговор",
            },
            "outbound:busy": {
              "color": "red",
              "icon": "outgoing",
              "label": "Занято",
            },
            "outbound:cancelled": {
              "color": "gray",
              "icon": "outgoing",
              "label": "Отменён",
            },
            "outbound:completed": {
              "color": "green",
              "icon": "outgoing",
              "label": "Исходящий",
            },
            "outbound:failed": {
              "color": "gray",
              "icon": "failed",
              "label": "Не удалось",
            },
            "outbound:missed": {
              "color": "gray",
              "icon": "outgoing",
              "label": "Без ответа",
            },
            "outbound:no_answer": {
              "color": "red",
              "icon": "outgoing",
              "label": "Без ответа",
            },
            "outbound:rejected": {
              "color": "gray",
              "icon": "outgoing",
              "label": "Отклонён абонентом",
            },
            "outbound:ringing": {
              "color": "green",
              "icon": "outgoing",
              "label": "Идёт дозвон…",
            },
          }
        `)
    })

    test('preserves completed call duration formatting', () => {
        expect(callStatusLabel('inbound', 'completed', 65)).toBe('Входящий · 01:05')
        expect(callStatusLabel('outbound', 'completed', 42)).toBe('Исходящий · 00:42')
    })
})
