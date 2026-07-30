import { describe, expect, it } from 'vitest'
import { PersonalMaxSendLane } from '../personal-max-send-lane'

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

describe('Personal MAX browser request lane', () => {
    it('preserves twenty rapid sends when the third request is slow', async () => {
        const lane = new PersonalMaxSendLane()
        const physicalOrder: string[] = []
        const texts = Array.from({ length: 20 }, (_, index) => `rapid-${String(index + 1).padStart(2, '0')}`)

        await Promise.all(texts.map(text => lane.enqueue('contact-a', async () => {
            physicalOrder.push(text)
            if (text === 'rapid-03') await wait(25)
        })))

        expect(physicalOrder).toEqual(texts)
        expect(lane.activeLaneCount).toBe(0)
    })

    it('does not globally serialize independent chats', async () => {
        const lane = new PersonalMaxSendLane()
        const order: string[] = []
        await Promise.all([
            lane.enqueue('contact-a', async () => { await wait(20); order.push('A1') }),
            lane.enqueue('contact-b', async () => { order.push('B1') }),
            lane.enqueue('contact-a', async () => { order.push('A2') }),
            lane.enqueue('contact-b', async () => { order.push('B2') }),
        ])

        expect(order.indexOf('A1')).toBeLessThan(order.indexOf('A2'))
        expect(order.indexOf('B1')).toBeLessThan(order.indexOf('B2'))
        expect(order.indexOf('B1')).toBeLessThan(order.indexOf('A1'))
    })

    it('does not poison a lane after a failed pre-action request', async () => {
        const lane = new PersonalMaxSendLane()
        const order: string[] = []
        const failed = lane.enqueue('contact-a', async () => {
            order.push('failed-before-provider')
            throw new Error('synthetic pre-action refusal')
        })
        const following = lane.enqueue('contact-a', async () => { order.push('following') })

        await expect(failed).rejects.toThrow('synthetic pre-action refusal')
        await following
        expect(order).toEqual(['failed-before-provider', 'following'])
    })
})
