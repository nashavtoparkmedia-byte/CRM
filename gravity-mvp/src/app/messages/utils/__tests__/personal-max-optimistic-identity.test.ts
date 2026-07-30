import { describe, expect, it } from 'vitest'
import { pendingOptimisticMessages } from '../personal-max-optimistic-identity'

describe('Personal MAX optimistic message identity', () => {
  it('keeps the second identical send until its own durable identity appears', () => {
    const cached = [
      { id: 'cmid-first', clientMessageId: 'cmid-first', content: 'Одинаковое сообщение' },
      { id: 'cmid-second', clientMessageId: 'cmid-second', content: 'Одинаковое сообщение' },
    ]
    const durable = [
      { clientMessageId: 'cmid-first', content: 'Одинаковое сообщение' },
    ]

    expect(pendingOptimisticMessages(cached, durable)).toEqual([cached[1]])
  })

  it('removes only the matching optimistic identity after both sends persist', () => {
    const cached = [
      { id: 'cmid-first', clientMessageId: 'cmid-first' },
      { id: 'cmid-second', clientMessageId: 'cmid-second' },
    ]
    const durable = [
      { clientMessageId: 'cmid-first' },
      { clientMessageId: 'cmid-second' },
    ]

    expect(pendingOptimisticMessages(cached, durable)).toEqual([])
  })
})
