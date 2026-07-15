import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ContactDriverProfilePayload } from '@/lib/contact-profile-contract'
import {
  countUniqueProviderChannels,
  formatAttachButton,
  formatAttachedProfilesHeader,
  formatFoundProfilesSummary,
  formatProviderChannelCount,
  formatSelectedProfilesSummary,
  getEmploymentTypeLabel,
  getIdentitySourceLabel,
  groupDriverProfilesByPark,
  isSuggestedProfileSelectable,
} from '@/lib/contact-profile-ui'

function profile(overrides: Partial<ContactDriverProfilePayload> = {}): ContactDriverProfilePayload {
  return {
    id: 'profile-1',
    yandexDriverId: 'legacy-1',
    externalDriverProfileId: 'external-1',
    externalParkId: 'external-park-1',
    fullName: 'Иванов Иван Иванович',
    phone: '+79990000000',
    lastExternalPark: 'YOKO',
    parkCode: 'YOKO',
    parkName: 'YOKO',
    employmentTypeCode: 'park_employee',
    employmentTypeLabel: 'Физлицо',
    employmentType: 'park_employee',
    workStatus: 'working',
    currentStatus: 'offline',
    segment: 'unknown',
    status: 'working',
    normalizedStatus: 'working',
    statusLabel: 'Работает',
    isMain: false,
    contactId: null,
    conflictContactId: null,
    conflictContact: null,
    linkedContactConflict: false,
    linkedContactSummary: null,
    matchedSignals: ['phone'],
    suggestionBasis: 'phone',
    suggestionBasisLabel: 'Совпадение номера телефона',
    personResolutionStatus: 'unlinked',
    personResolutionBasis: null,
    externalPersonKey: null,
    lastOrderAt: null,
    hiredAt: null,
    dismissedAt: null,
    sourceUpdatedAt: null,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    ...overrides,
  }
}

describe('suggested profile UI mapping', () => {
  test('maps only source-proven Yandex employment enums and degrades unknown values safely', () => {
    expect(getEmploymentTypeLabel('park_employee')).toBe('Физлицо')
    expect(getEmploymentTypeLabel('selfemployed')).toBe('Парковый СМЗ')
    expect(getEmploymentTypeLabel('individual_entrepreneur')).toBe('Парковый ИП')
    expect(getEmploymentTypeLabel('future_enum')).toBe('Тип оформления не определён')
    expect(getEmploymentTypeLabel(null)).toBe('Тип оформления не определён')
  })

  test('groups by park code in approved order with active profiles first and dismissed collapsed separately', () => {
    const groups = groupDriverProfilesByPark([
      profile(),
      profile({ id: 'delivery', parkCode: 'YOKO_DELIVERY', parkName: 'YOKO.Доставка' }),
      profile({ id: 'yoko-dismissed', normalizedStatus: 'dismissed', status: 'dismissed', statusLabel: 'Уволен' }),
      profile({ id: 'nash', parkCode: 'NASH_AVTOPARK', parkName: 'Наш Автопарк' }),
      profile({ id: 'yoko-active-2', fullName: 'Петров Пётр Петрович' }),
    ])

    expect(groups.map(group => group.parkName)).toEqual(['Наш Автопарк', 'YOKO', 'YOKO.Доставка'])
    expect(groups[1].active.map(item => item.id)).toEqual(['profile-1', 'yoko-active-2'])
    expect(groups[1].dismissed.map(item => item.id)).toEqual(['yoko-dismissed'])
    expect(groups[1].activeCount).toBe(2)
  })

  test('uses correct Russian forms for zero, singular, plural, and unique park counts', () => {
    expect(formatFoundProfilesSummary(6, 6)).toBe('Найдено 6 профилей в 6 парках')
    expect(formatFoundProfilesSummary(9, 6)).toBe('Найдено 9 профилей в 6 парках')
    expect(formatFoundProfilesSummary(1, 1)).toBe('Найден 1 профиль в 1 парке')
    expect(formatSelectedProfilesSummary(1, 1)).toBe('Выбран 1 профиль из 1 парка')
    expect(formatSelectedProfilesSummary(3, 3)).toBe('Выбрано 3 профиля из 3 парков')
    expect(formatSelectedProfilesSummary(6, 6)).toBe('Выбрано 6 профилей из 6 парков')
    expect(formatAttachButton(0)).toBe('Привязать выбранные')
    expect(formatAttachButton(1)).toBe('Привязать 1 профиль')
    expect(formatAttachButton(3)).toBe('Привязать 3 профиля')
  })

  test('counts unique providers and does not count duplicate identities', () => {
    expect(countUniqueProviderChannels([
      { channel: 'max' },
      { channel: 'telegram' },
      { channel: 'whatsapp' },
      { channel: 'telegram' },
    ])).toBe(3)
    expect(countUniqueProviderChannels(['max', 'MAX', 'telegram'])).toBe(2)
    expect(formatProviderChannelCount(1)).toBe('1 канал')
    expect(formatProviderChannelCount(2)).toBe('2 канала')
    expect(formatProviderChannelCount(3)).toBe('3 канала')
    expect(formatProviderChannelCount(5)).toBe('5 каналов')
    expect(formatProviderChannelCount(21)).toBe('21 канал')
    expect(formatAttachedProfilesHeader(6, 6)).toBe('Профили водителя: 6 в 6 парках')
    expect(formatAttachedProfilesHeader(1, 1)).toBe('Профили водителя: 1 в 1 парке')
  })

  test('humanizes identity source and excludes linked conflicts from selection', () => {
    expect(getIdentitySourceLabel('auto')).toBe('Автоматически')
    expect(getIdentitySourceLabel('manual')).toBe('Вручную')
    expect(getIdentitySourceLabel('imported')).toBe('Связан')
    expect(isSuggestedProfileSelectable(profile())).toBe(true)
    expect(isSuggestedProfileSelectable(profile({ linkedContactConflict: true }))).toBe(false)
  })
})

describe('suggested profile source contracts', () => {
  const root = resolve(process.cwd())
  const panel = readFileSync(resolve(root, 'src/app/messages/components/ContactDriverProfilesPanel.tsx'), 'utf8')
  const drawer = readFileSync(resolve(root, 'src/app/messages/components/ContactProfileDrawer.tsx'), 'utf8')
  const header = readFileSync(resolve(root, 'src/app/messages/components/ChatHeader.tsx'), 'utf8')

  test('raw employment enums are not rendered by the production panel', () => {
    expect(panel).not.toContain("profile.employmentType ||")
    expect(panel).not.toContain('park_employee')
    expect(panel).toContain('profile.employmentTypeLabel')
  })

  test('technical data is at the bottom of the real drawer, after Context, and not inside the driver panel', () => {
    expect(panel).not.toContain('data-testid="technical-data"')
    expect(drawer.indexOf('data-testid="technical-data"')).toBeGreaterThan(drawer.indexOf('{/* Context Info */}'))
  })

  test('both channel counters use unique canonical provider channels', () => {
    expect(header).toContain('countUniqueProviderChannels(contact.channels)')
    expect(drawer).toContain('countUniqueProviderChannels(contact.channels)')
    expect(header).toContain('formatProviderChannelCount(channelCount)')
    expect(drawer).toContain('formatProviderChannelCount(drawerChannelCount)')
    expect(drawer).not.toContain('contact.identities.length} канала')
  })

  test('main selection uses a CRM dialog and source badge is explicit', () => {
    expect(panel).not.toContain('window.confirm')
    expect(panel).toContain('data-testid="main-profile-confirmation"')
    expect(panel).toContain('Сделать профиль главным?')
    expect(drawer).toContain('Источник: {sourceInfo.label}')
  })
})
