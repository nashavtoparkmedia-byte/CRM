import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('reachability UI source guards', () => {
  test('a linked CRM Chat cannot become a green provider account answer', () => {
    const source = readSource('src/app/messages/components/ContactProfileDrawer.tsx')

    expect(source).toContain('deriveChannelReachabilityPresentation')
    expect(source).toContain('routeKnown')
    expect(source).not.toContain('hasOperationalMaxChat')
    expect(source).not.toContain('effectiveReachable')
    expect(source).not.toMatch(/linkedToCurrentContact\s*\?\s*\{\s*label:\s*['"]Связан['"]/)
    expect(source).toContain('entry.identityId !== target.identityId')
    expect(source).toContain('entry.phone !== target.phone')
  })

  test('the client makes one decision and owns no reachability retry loop', () => {
    const drawer = readSource('src/app/messages/components/ContactProfileDrawer.tsx')
    const popover = readSource('src/app/messages/components/NewChatPopover.tsx')

    expect(drawer).not.toContain('retryTimers')
    expect(popover).not.toContain('retryTimer')
    expect(popover).not.toContain('attempts < 5')
    expect(popover).toContain('The server owns TTL')
  })

  test('no-connection copy remains distinct from a provider-level no answer', () => {
    const helper = readSource('src/lib/channel-reachability-ui.ts')

    expect(helper).toContain("label: 'нет связи'")
    expect(helper).toContain("label: 'нет'")
    expect(helper).toContain('Это не ответ провайдера')
  })
})
