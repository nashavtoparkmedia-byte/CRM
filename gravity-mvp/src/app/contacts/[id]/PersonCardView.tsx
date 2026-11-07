import Link from 'next/link'
import { formatContactPhone } from '@/modules/contacts/public/v1/contact-display-policy'
import type {
  ContactPersonCardAccountV1,
  ContactPersonCardConflictV1,
  ContactPersonCardPhoneV1,
  ContactPersonConfirmationV1,
} from '@/contracts/contacts/v1'
import type {
  ContactPersonCardConversationV1,
  ContactPersonCardDriverProfileV1,
  ContactPersonCardViewV1,
} from '@/modules/platform-shell/public/v1'

// Presentation only. Every label below is a translation of an enum the read
// models already decided; nothing here infers a relationship, a replacement or
// a confirmation that the data does not state.

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX', phone: 'Телефон', avito: 'Avito',
}
const channelLabel = (channel: string) => CHANNEL_LABELS[channel] ?? channel

const CONFIRMATION_LABELS: Record<ContactPersonConfirmationV1['state'], { text: string; tone: Tone }> = {
  confirmed: { text: 'Личность подтверждена', tone: 'ok' },
  needs_reconciliation: { text: 'Требует сверки', tone: 'warn' },
  contradiction: { text: 'Конфликт личности', tone: 'bad' },
  unconfirmed: { text: 'Личность не подтверждена', tone: 'muted' },
}

const PROFILE_STATUS_LABELS: Record<ContactPersonCardDriverProfileV1['personResolutionStatus'], string> = {
  operator_confirmed: 'Подтверждён оператором',
  vu_clustered: 'Сгруппирован по ВУ',
  vu_observed: 'Наблюдается по ВУ',
  unlinked: 'Связь не установлена',
  conflict: 'Конфликт',
  unknown: 'Статус неизвестен',
}

const PHONE_LIFECYCLE_LABELS: Record<ContactPersonCardPhoneV1['lifecycle'], string> = {
  current: 'текущий', superseded: 'заменён', removed: 'удалён', unknown: '',
}
const PHONE_TRUST_LABELS: Record<ContactPersonCardPhoneV1['trust'], string> = {
  provider_bound: 'из источника', manually_verified: 'подтверждён вручную', source_asserted: 'по данным источника', claimed: 'заявлен', unknown: '',
}
const REACHABILITY_LABELS: Record<ContactPersonCardAccountV1['reachabilityStatus'], string> = {
  confirmed: 'доступен', unreachable: 'недоступен', unknown: '',
}
const CANDIDATE_BASIS_LABELS: Record<string, string> = {
  needs_reconciliation: 'ожидает сверки оператором',
  open_conflict: 'назван в открытом конфликте',
}
const CONFLICT_CLASS_LABELS: Record<string, string> = {
  channel_identity_collision: 'коллизия аккаунта канала',
  provider_identity_alias_collision: 'коллизия алиаса провайдера',
  stable_identity_phone_contradiction: 'аккаунт и телефон противоречат',
  confirmed_driver_cluster_contradiction: 'противоречие подтверждений водителя',
  fleet_authoritative_person_contradiction: 'противоречие с данными парка',
  identity_conflict_flag: 'аккаунт помечен конфликтным',
  unknown: 'конфликт (тип не распознан)',
}

type Tone = 'ok' | 'warn' | 'bad' | 'muted'
const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-[#059669]/10 text-[#047857]',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-[#DC2626]',
  muted: 'bg-[#F1F5FD] text-[#64748B]',
}

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-medium ${TONE_CLASSES[tone]}`}>{children}</span>
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[#E4ECFC] bg-white">
      <header className="flex items-center justify-between px-4 h-[44px] border-b border-[#E4ECFC]">
        <h2 className="text-[15px] font-semibold text-[#0F172A]">{title}</h2>
        {count !== undefined && <span className="text-[12px] text-[#64748B]">{count}</span>}
      </header>
      <div>{children}</div>
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-3 px-4 min-h-[56px] py-2 border-b border-[#E4ECFC] last:border-b-0">{children}</div>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-4 text-[13px] text-[#64748B]">{children}</div>
}

function formatDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function DriverProfileRow({ profile }: { profile: ContactPersonCardDriverProfileV1 }) {
  const stale = profile.sourceFreshness === 'stale' || profile.sourceState === 'stale' || profile.sourceState === 'failed'
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/drivers/${encodeURIComponent(profile.driverId)}`} className="text-[15px] font-medium text-[#0F172A] hover:text-[#2AABEE]">
            {profile.parkName ?? (profile.externalParkId ? `Парк ${profile.externalParkId}` : 'Парк не указан')}
          </Link>
          {profile.isMainDriver && <Badge tone="muted">основной профиль</Badge>}
          <Badge tone={profile.personResolutionStatus === 'operator_confirmed' ? 'ok' : profile.personResolutionStatus === 'conflict' ? 'bad' : 'muted'}>
            {PROFILE_STATUS_LABELS[profile.personResolutionStatus]}
          </Badge>
          {profile.linkBasis === 'legacy_yandex_link' && <Badge tone="muted">по прежней связи</Badge>}
          {profile.linkContradiction && <Badge tone="bad">профиль привязан к другому контакту</Badge>}
        </div>
        <div className="mt-0.5 text-[13px] text-[#64748B]">
          {profile.fullName}
          {profile.currentStatus || profile.workStatus ? ` · ${profile.currentStatus ?? profile.workStatus}` : ''}
          {profile.legalRole ? ` · ${profile.legalRole}` : ''}
          {profile.dismissedAt ? ` · уволен ${formatDate(profile.dismissedAt) ?? ''}` : ''}
          {stale ? ' · данные источника устарели' : ''}
        </div>
      </div>
      <span className="text-[12px] text-[#64748B]">{formatDate(profile.lastObservedAt) ?? ''}</span>
    </Row>
  )
}

function AccountRow({ account, conversation }: { account: ContactPersonCardAccountV1; conversation: ContactPersonCardConversationV1 | undefined }) {
  const title = account.displayName ?? (account.username ? `@${account.username}` : account.externalId)
  const reach = REACHABILITY_LABELS[account.reachabilityStatus]
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-medium text-[#0F172A] truncate">{title}</span>
          {!account.isActive && <Badge tone="muted">неактивный</Badge>}
          {account.conflictState === 'conflicted' && <Badge tone="bad">конфликт</Badge>}
          {account.source === 'manual' && <Badge tone="muted">привязан вручную</Badge>}
        </div>
        <div className="mt-0.5 text-[13px] text-[#64748B] truncate">
          {account.username && account.displayName ? `@${account.username} · ` : ''}
          id {account.externalId}
          {account.aliasCount > 0 ? ` · алиасов: ${account.aliasCount}` : ''}
          {reach ? ` · ${reach}` : ''}
        </div>
      </div>
      {account.isActive && conversation && (
        <a href={`/messages/open?chat=${encodeURIComponent(conversation.primaryConversationId)}`} className="text-[13px] font-medium text-[#2AABEE] whitespace-nowrap">
          Переписка
        </a>
      )}
    </Row>
  )
}

function PhoneRow({ phone }: { phone: ContactPersonCardPhoneV1 }) {
  const lifecycle = PHONE_LIFECYCLE_LABELS[phone.lifecycle]
  const trust = PHONE_TRUST_LABELS[phone.trust]
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-medium text-[#0F172A]">{formatContactPhone(phone.phone) ?? phone.phone}</span>
          {phone.isPrimary && <Badge tone="muted">основной</Badge>}
          {lifecycle && <Badge tone={phone.lifecycle === 'current' ? 'ok' : 'muted'}>{lifecycle}</Badge>}
          {phone.resolutionState === 'shared' && <Badge tone="warn">используется другим контактом</Badge>}
          {phone.resolutionState === 'disputed' && <Badge tone="bad">спорный</Badge>}
        </div>
        <div className="mt-0.5 text-[13px] text-[#64748B]">
          {trust}{trust && phone.verifiedAt ? ` · ${formatDate(phone.verifiedAt)}` : ''}
        </div>
      </div>
    </Row>
  )
}

function ConflictRow({ conflict }: { conflict: ContactPersonCardConflictV1 }) {
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-[#0F172A]">{CONFLICT_CLASS_LABELS[conflict.conflictClass] ?? conflict.conflictClass}</span>
          <Badge tone={conflict.personBlocking ? 'bad' : 'warn'}>{conflict.personBlocking ? 'блокирует операции' : conflict.scope === 'transport_only' ? 'только транспорт' : 'открыт'}</Badge>
          {conflict.channel && <Badge tone="muted">{channelLabel(conflict.channel)}</Badge>}
        </div>
        <div className="mt-0.5 text-[13px] text-[#64748B]">
          {formatDate(conflict.detectedAt) ?? ''}
          {conflict.otherContactId ? <> · другой контакт: <Link href={`/contacts/${encodeURIComponent(conflict.otherContactId)}`} className="text-[#2AABEE]">{conflict.otherContactId}</Link></> : null}
        </div>
      </div>
    </Row>
  )
}

export default function PersonCardView({ view }: { view: ContactPersonCardViewV1 }) {
  const { card, driverProfiles, conversations, partial } = view
  const confirmation = CONFIRMATION_LABELS[card.personConfirmation.state]
  const conversationByChannel = new Map(conversations.map(conversation => [conversation.channel, conversation]))
  const openConflicts = card.conflicts.filter(conflict => conflict.status === 'open')
  return (
    <div className="space-y-4 max-w-[860px]">
      <header className="rounded-xl border border-[#E4ECFC] bg-white px-4 py-4">
        <h1 className="text-[20px] font-semibold text-[#0F172A]">{card.displayName}</h1>
        {card.primaryPhone && <div className="mt-0.5 text-[15px] text-[#64748B]">{card.primaryPhone}</div>}
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone={confirmation.tone}>{confirmation.text}</Badge>
          {card.personConfirmation.state === 'confirmed' && card.personConfirmation.confirmedPersonName && card.personConfirmation.confirmedPersonName !== card.displayName && (
            <Badge tone="muted">в парке: {card.personConfirmation.confirmedPersonName}</Badge>
          )}
          {card.hasPersonBlockingConflict && <Badge tone="bad">есть блокирующий конфликт</Badge>}
          {card.automation.doNotMerge && <Badge tone="muted">объединение запрещено</Badge>}
          {card.automation.canonicalPinned && <Badge tone="muted">имя закреплено вручную</Badge>}
          {card.lineage.mergedFromCount > 0 && <Badge tone="muted">объединён из {card.lineage.mergedFromCount}</Badge>}
        </div>
      </header>

      <Section title="Профили водителя и парки" count={driverProfiles.length}>
        {partial.driverProfiles && <Empty>Данные парков сейчас недоступны. Показано только то, что известно Contacts.</Empty>}
        {!partial.driverProfiles && driverProfiles.length === 0 && <Empty>Связанных водительских профилей нет.</Empty>}
        {driverProfiles.map(profile => <DriverProfileRow key={profile.driverId} profile={profile} />)}
      </Section>

      <Section title="Аккаунты связи" count={card.channels.reduce((sum, channel) => sum + channel.accounts.length, 0)}>
        {card.channels.length === 0 && <Empty>Аккаунтов мессенджеров не зафиксировано.</Empty>}
        {partial.conversations && <Empty>Переписки сейчас недоступны; аккаунты показаны без перехода в чат.</Empty>}
        {card.channels.map(channel => {
          const active = channel.accounts.filter(account => account.isActive)
          const inactive = channel.accounts.filter(account => !account.isActive)
          const conversation = conversationByChannel.get(channel.channel)
          return (
            <div key={channel.channel}>
              <div className="flex items-center justify-between px-4 h-[36px] bg-[#F1F5FD] text-[13px] font-medium text-[#64748B]">
                <span>{channelLabel(channel.channel)}</span>
                {conversation && (
                  <span>{conversation.conversationCount} {conversation.conversationCount === 1 ? 'переписка' : 'переписок'}{conversation.truncated ? '+' : ''}</span>
                )}
              </div>
              {active.length === 0 && <Empty>Активных аккаунтов нет.</Empty>}
              {active.map(account => <AccountRow key={account.identityId} account={account} conversation={conversation} />)}
              {inactive.length > 0 && (
                <details className="border-t border-[#E4ECFC]">
                  <summary className="cursor-pointer px-4 h-[44px] flex items-center text-[13px] text-[#64748B] hover:bg-[#F1F5FD]">
                    Прежние аккаунты ({inactive.length})
                  </summary>
                  {inactive.map(account => <AccountRow key={account.identityId} account={account} conversation={undefined} />)}
                </details>
              )}
            </div>
          )
        })}
      </Section>

      <Section title="Телефоны" count={card.phones.length}>
        {card.phones.length === 0 && <Empty>Телефонов не зафиксировано.</Empty>}
        {card.phones.map(phone => <PhoneRow key={phone.phoneId} phone={phone} />)}
      </Section>

      <Section title="Связи и история" count={openConflicts.length + card.candidates.length + card.lineage.mergeHistory.length}>
        {card.candidates.length > 0 && (
          <div>
            <div className="px-4 h-[36px] flex items-center bg-[#F1F5FD] text-[13px] font-medium text-[#64748B]">Возможно тот же человек — не подтверждено</div>
            {card.candidates.map(candidate => (
              <Row key={candidate.contactId}>
                <div className="min-w-0 flex-1">
                  <Link href={`/contacts/${encodeURIComponent(candidate.contactId)}`} className="text-[15px] font-medium text-[#2AABEE]">Контакт {candidate.contactId}</Link>
                  <div className="mt-0.5 text-[13px] text-[#64748B]">{CANDIDATE_BASIS_LABELS[candidate.basis] ?? candidate.basis}. Подтверждение — только через существующую проверку в «Сообщениях».</div>
                </div>
              </Row>
            ))}
          </div>
        )}
        {openConflicts.length > 0 && (
          <div>
            <div className="px-4 h-[36px] flex items-center bg-[#F1F5FD] text-[13px] font-medium text-[#64748B]">Открытые конфликты</div>
            {openConflicts.map((conflict, index) => <ConflictRow key={`${conflict.origin}-${conflict.identityId ?? 'contact'}-${index}`} conflict={conflict} />)}
          </div>
        )}
        {card.lineage.mergeHistory.length > 0 && (
          <div>
            <div className="px-4 h-[36px] flex items-center bg-[#F1F5FD] text-[13px] font-medium text-[#64748B]">История объединений</div>
            {card.lineage.mergeHistory.map(event => (
              <Row key={event.mergeId}>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] text-[#0F172A]">
                    {event.action === 'merge' ? 'Объединение' : 'Разъединение'} · {event.reason}
                  </div>
                  <div className="mt-0.5 text-[13px] text-[#64748B]">
                    {formatDate(event.createdAt) ?? ''} · {event.mergedBy} · {event.mergedContactId} → {event.survivorContactId}
                  </div>
                </div>
              </Row>
            ))}
          </div>
        )}
        {openConflicts.length === 0 && card.candidates.length === 0 && card.lineage.mergeHistory.length === 0 && (
          <Empty>Конфликтов, кандидатов и объединений не зафиксировано.</Empty>
        )}
      </Section>
    </div>
  )
}
