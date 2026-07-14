import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('multi-park source contracts', () => {
  test('Yandex driver sync processes all ApiConnection rows instead of last created connection', () => {
    const actions = read('src/app/drivers/actions.ts')
    expect(actions).toContain('prisma.apiConnection.findMany')
    expect(actions).toContain('for (const connection of connections)')
    expect(actions).toContain('lastExternalPark: parkName')
    expect(actions).not.toContain("await linkContactToBestDriver(phone)")
  })

  test('Yandex trips sync processes all parks and reports per-park results', () => {
    const service = read('src/lib/YandexFleetService.ts')
    expect(service).toContain('prisma.apiConnection.findMany')
    expect(service).toContain('for (const connection of connections)')
    expect(service).toContain('parkResults')
    expect(service).toContain('Yandex trips sync failed for all parks')
  })

  test('legacy monitoring sync also processes all parks and keeps partial park failures isolated', () => {
    const route = read('src/app/api/monitoring/sync/route.ts')
    expect(route).toContain('prisma.apiConnection.findMany')
    expect(route).toContain('parkResults')
    expect(route).toContain('All Yandex park syncs failed')
    expect(route).toContain('monitoring-sync:${parkName}')
  })

  test('Contact drawer does not display fake driver park or role when no DriverProfile exists', () => {
    const drawer = read('src/app/messages/components/ContactProfileDrawer.tsx')
    const profilePanel = read('src/app/messages/components/ContactDriverProfilesPanel.tsx')
    expect(drawer).not.toContain("value: 'Яндекс'")
    expect(drawer).not.toContain("value: 'Водитель'")
    expect(profilePanel).toContain('Профиль водителя не привязан')
    expect(profilePanel).toContain('Обновляем данные')
    expect(profilePanel).toContain('Сделать главным')
    expect(profilePanel).toContain('Возможные профили водителя: {suggestions.length}')
    expect(profilePanel).not.toContain('data-testid="technical-data"')
    expect(drawer).toContain('data-testid="technical-data"')
    expect(drawer.indexOf('data-testid="technical-data"')).toBeGreaterThan(drawer.indexOf('{/* Context Info */}'))
  })

  test('Contact opening triggers background DriverProfile refresh endpoint', () => {
    const hook = read('src/app/messages/hooks/useContact.ts')
    const route = read('src/app/api/contacts/[id]/driver-profiles/refresh/route.ts')
    expect(hook).toContain('/driver-profiles/refresh')
    expect(hook).toContain('profileSyncState')
    expect(route).toContain('refreshContactMainDriver')
    expect(route).toContain('card-open-refresh')
  })
})
