"use client"

import type {
  ContactDriver,
  ContactIdentity,
  ContactPhone,
} from '../hooks/useContact'

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? '—'
}

function dateText(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU')
}

function phoneText(value: string): string {
  if (value.length === 12 && value.startsWith('+7')) {
    return `+7 ${value.slice(2, 5)} ${value.slice(5, 8)}-${value.slice(8, 10)}-${value.slice(10)}`
  }
  return value
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 border-b border-gray-100 py-1 last:border-0">
      <dt className="text-[11px] text-gray-500">{label}</dt>
      <dd className="break-all text-[11px] text-gray-900">{valueText(value)}</dd>
    </div>
  )
}

function identityOrigin(identity: ContactIdentity): string {
  if (identity.source === 'manual') return 'ручная'
  if (identity.source === 'auto') return 'автоматическая'
  return identity.source || 'неизвестно'
}

function identityConflict(identity: ContactIdentity): string {
  const conflicts = identity.conflicts
    ?.map(conflict => conflict.conflictType)
    .filter((value): value is string => Boolean(value)) ?? []
  if (conflicts.length > 0) return conflicts.join(', ')
  return identity.conflictState === 'conflicted' ? 'конфликт' : 'нет'
}

export function ChannelIdentityEvidenceList({
  identities,
  phones,
}: {
  identities: ContactIdentity[]
  phones: ContactPhone[]
}) {
  const phonesById = new Map(phones.map(phone => [phone.id, phone.phone]))
  if (identities.length === 0) return <p className="text-xs text-gray-500">Каналы не найдены</p>
  return (
    <div className="space-y-3">
      {identities.map(identity => (
        <article key={identity.id} className="rounded-lg border border-gray-200 p-3">
          <h4 className="mb-2 text-sm font-semibold">{identity.channel.toUpperCase()}</h4>
          <dl>
            <Detail label="Провайдер" value={identity.channel} />
            <Detail label="Стабильный ID" value={identity.externalId} />
            <Detail
              label="Состояние связи"
              value={identity.isActive === false
                ? 'неактивна'
                : identity.phoneId ? 'активна · телефон связан' : 'активна · без телефона'}
            />
            <Detail label="Источник привязки" value={identityOrigin(identity)} />
            <Detail label="Происхождение" value={identity.origin} />
            <Detail label="Аккаунт провайдера" value={identity.providerAccountId} />
            <Detail label="Основание" value={identity.evidenceRoot} />
            <Detail
              label="Связанный телефон"
              value={identity.phoneId ? phoneText(phonesById.get(identity.phoneId) ?? identity.phoneId) : '—'}
            />
            <Detail label="Доступность" value={identity.reachabilityStatus} />
            <Detail label="Проверено" value={dateText(identity.reachabilityCheckedAt)} />
            <Detail label="Конфликт" value={identityConflict(identity)} />
          </dl>
        </article>
      ))}
    </div>
  )
}

const SOURCE_DATE_LABELS: Record<string, string> = {
  createdDate: 'Создан в источнике',
  modifiedDate: 'Изменён в источнике',
  hireDate: 'Дата найма',
  statusUpdatedAt: 'Статус обновлён',
}

function driverPhones(profile: ContactDriver): string[] {
  return [...new Set([...(profile.sourcePhones ?? []), ...(profile.phone ? [profile.phone] : [])])]
}

export function DriverProfileEvidenceList({ profiles }: { profiles: ContactDriver[] }) {
  if (profiles.length === 0) return <p className="text-xs text-gray-500">Профили водителя не найдены</p>
  return (
    <div className="space-y-3">
      {profiles.map(profile => {
        const park = profile.park?.parkName || profile.externalParkId || '—'
        const externalPark = profile.park?.externalParkId || profile.externalParkId
        const phones = driverPhones(profile)
        const resolution = [profile.personResolutionStatus, profile.personResolutionBasis]
          .filter(Boolean)
          .join(' · ')
        return (
          <article key={profile.id} className="rounded-lg border border-gray-200 p-3">
            <h4 className="mb-2 text-sm font-semibold">{profile.fullName || 'Без имени'}</h4>
            <dl>
              <Detail label="Парк" value={externalPark && externalPark !== park ? `${park} (${externalPark})` : park} />
              <Detail label="Юридическая роль" value={profile.legalRole || profile.sourceProfileType} />
              <Detail label="Рабочий статус" value={profile.workStatus ?? profile.sourceStatus} />
              <Detail label="Текущий статус" value={profile.currentStatus ?? profile.sourceStatus} />
              <Detail label="ФИО" value={profile.fullName} />
              <Detail label="Телефоны" value={phones.length ? phones.map(phoneText).join(', ') : '—'} />
              <Detail
                label="ВУ"
                value={profile.normalizedVu && profile.normalizedVu !== profile.licenseNumber
                  ? `${profile.licenseNumber || '—'} (норм. ${profile.normalizedVu})`
                  : profile.licenseNumber || profile.normalizedVu}
              />
              <Detail label="ID профиля в источнике" value={profile.externalDriverProfileId} />
              {Object.entries(profile.sourceDates ?? {}).map(([key, value]) => (
                <Detail key={key} label={SOURCE_DATE_LABELS[key] || key} value={dateText(value)} />
              ))}
              <Detail label="Наблюдался" value={dateText(profile.lastObservedAt)} />
              <Detail label="Синхронизирован" value={dateText(profile.lastSynchronizedAt)} />
              <Detail label="Актуальность" value={profile.sourceFreshness} />
              <Detail label="Состояние источника" value={profile.sourceState} />
              <Detail label="Состояние сопоставления" value={resolution || '—'} />
              <Detail label="Конфликт источника" value={profile.sourceConflict ? profile.sourceConflict : 'нет'} />
            </dl>
          </article>
        )
      })}
    </div>
  )
}

export default function ContactEvidenceDetails({
  identities,
  phones,
  profiles,
}: {
  identities: ContactIdentity[]
  phones: ContactPhone[]
  profiles: ContactDriver[]
}) {
  return (
    <div className="space-y-5">
      <section aria-labelledby="contact-evidence-channels">
        <h3 id="contact-evidence-channels" className="mb-2 text-sm font-semibold">Каналы</h3>
        <ChannelIdentityEvidenceList identities={identities} phones={phones} />
      </section>
      <section aria-labelledby="contact-evidence-profiles">
        <h3 id="contact-evidence-profiles" className="mb-2 text-sm font-semibold">Профили водителя</h3>
        <DriverProfileEvidenceList profiles={profiles} />
      </section>
    </div>
  )
}
