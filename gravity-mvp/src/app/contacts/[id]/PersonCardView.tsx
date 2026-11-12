import Link from 'next/link'
import { formatContactPhone } from '@/modules/contacts/public/v1/contact-display-policy'
import AiConversationPanel from '@/modules/calling/public/v1/client-ui/AiConversationPanel'
import { CardActions, MessengersTable, type CardConversationV1, type MessengerRowV1 } from './PersonCardClient'
import type {
  ContactPersonCardConflictV1,
  ContactPersonCardLinkEventV1,
  ContactPersonCardPhoneV1,
  ContactPersonConfirmationV1,
} from '@/contracts/contacts/v1'
import type {
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
      <header className="flex items-center justify-between px-4 h-[48px]">
        <h2 className="text-[17px] font-semibold text-[#0F172A]">{title}</h2>
        {count !== undefined && <span className="text-[12px] text-[#64748B]">{count}</span>}
      </header>
      <div>{children}</div>
    </section>
  )
}


function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-4 text-[13px] text-[#64748B]">{children}</div>
}

/** Russian plural form: 1 профиль, 2 профиля, 5 профилей. */
function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Stored channel → the desktop Messenger's channel tab (the same values /messages accepts). */
const MESSENGER_CHANNEL_TABS: Record<string, string> = { telegram: 'tg', whatsapp: 'wa', max: 'max', avito: 'av', phone: 'phone' }

function formatDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Employment as the Owner named it (2026-11-11): ФЛ, СМЗ, Парковый ИП; nothing is guessed. */
function employmentLabel(profile: ContactPersonCardDriverProfileV1): string {
  const byType: Record<string, string> = { park_employee: 'ФЛ', selfemployed: 'СМЗ', individual_entrepreneur: 'Парковый ИП' }
  const typed = profile.employmentType ? byType[profile.employmentType] ?? null : null
  if (typed === null) return profile.isSelfEmployed === true ? 'СМЗ' : '—'
  // Fleet stores both; when they disagree, both are shown rather than one picked.
  return profile.isSelfEmployed === true && profile.employmentType !== 'selfemployed' ? `${typed} · СМЗ` : typed
}

type ProfileStatus = { text: string; tone: 'active' | 'dismissed' | 'other' }

/** The source's own work status, named in Russian: working, not working, dismissed; otherwise a dash. */
function profileStatus(profile: ContactPersonCardDriverProfileV1): ProfileStatus {
  if (profile.workStatus === 'fired' || profile.dismissedAt) return { text: 'Уволен', tone: 'dismissed' }
  if (profile.workStatus === 'working') return { text: 'Активен', tone: 'active' }
  if (profile.workStatus === 'not_working') return { text: 'Не работает', tone: 'other' }
  return { text: '—', tone: 'other' }
}

function ParksTable({ profiles }: { profiles: ContactPersonCardDriverProfileV1[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left">
        <thead>
          <tr className="bg-[#F1F5FD] text-[13px] text-[#64748B]">
            <th className="px-4 py-2 font-medium">Телефон</th>
            <th className="px-4 py-2 font-medium">Парк</th>
            <th className="px-4 py-2 font-medium">Занятость</th>
            <th className="px-4 py-2 font-medium">Статус</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map(profile => {
            const status = profileStatus(profile)
            return (
              <tr key={profile.driverId} className="border-b border-[#E4ECFC] last:border-b-0 text-[14px] text-[#0F172A] align-top">
                <td className="px-4 py-3 whitespace-nowrap">{profile.phone ? formatContactPhone(profile.phone) ?? profile.phone : '—'}</td>
                <td className="px-4 py-3">
                  <Link href={`/drivers/${encodeURIComponent(profile.driverId)}`} className="font-medium hover:text-[#2AABEE]">
                    {profile.parkName ?? (profile.externalParkId ? `Парк ${profile.externalParkId}` : 'Парк не указан')}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {profile.isMainDriver && <Badge tone="muted">основной профиль</Badge>}
                    <Badge tone={profile.personResolutionStatus === 'operator_confirmed' ? 'ok' : profile.personResolutionStatus === 'conflict' ? 'bad' : 'muted'}>
                      {PROFILE_STATUS_LABELS[profile.personResolutionStatus]}
                    </Badge>
                    {profile.linkBasis === 'legacy_yandex_link' && <Badge tone="muted">по прежней связи</Badge>}
                    {profile.linkContradiction && <Badge tone="bad">профиль привязан к другому контакту</Badge>}
                  </div>
                  <div className="mt-1 text-[12px] text-[#64748B]">
                    {profile.fullName}
                    {profile.licence ? ` · ВУ ${profile.licence}` : ''}
                    {profile.sourceFreshness === 'stale' || profile.sourceState === 'stale' || profile.sourceState === 'failed' ? ' · данные источника устарели' : ''}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{employmentLabel(profile)}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    {status.tone !== 'other' && <span className={`h-2 w-2 rounded-full ${status.tone === 'active' ? 'bg-[#2AABEE]' : 'bg-[#DC2626]'}`} aria-hidden="true" />}
                    {status.text}
                    {status.tone === 'dismissed' && profile.dismissedAt ? <span className="text-[12px] text-[#64748B]">{formatDate(profile.dismissedAt)}</span> : null}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const MESSENGER_CHANNELS = ['whatsapp', 'telegram', 'max'] as const

/** WhatsApp ids are phone numbers (79991234567@c.us); show them as one. */
function accountLabel(account: { externalId: string; username: string | null; displayName: string | null; linkedPhoneId: string | null }, channel: string, phones: Map<string, string>): string {
  if (account.linkedPhoneId && phones.has(account.linkedPhoneId)) return formatContactPhone(phones.get(account.linkedPhoneId)!) ?? phones.get(account.linkedPhoneId)!
  if (account.username) return `@${account.username}`
  if (channel === 'whatsapp') {
    const digits = account.externalId.replace(/@.*$/u, '')
    if (/^\d{10,15}$/u.test(digits)) return formatContactPhone(`+${digits}`) ?? `+${digits}`
  }
  return account.displayName ?? account.externalId
}

/**
 * Block 2 rows: every stored account of the person (several per messenger
 * when they exist, former ones included), then every current phone × messenger
 * the person has no account on yet, as «не проверен». Presence is what the
 * existing reachability check persisted; the bot column waits for Telegram's
 * stored-link read and «Для связи» for Messaging's preference, so both say they
 * are unknown rather than guess.
 */
function messengerRows(view: ContactPersonCardViewV1): MessengerRowV1[] {
  const { card, conversations } = view
  const phones = new Map(card.phones.map(phone => [phone.phoneId, phone.phone]))
  const conversationByChannel = new Map(conversations.map(conversation => [conversation.channel, conversation]))
  const rows: MessengerRowV1[] = []
  const channelOrder = (channel: string) => { const index = (MESSENGER_CHANNELS as readonly string[]).indexOf(channel); return index < 0 ? 99 : index }
  const channels = [...card.channels].sort((a, b) => channelOrder(a.channel) - channelOrder(b.channel))
  for (const channel of channels) {
    const active = channel.accounts.filter(account => account.isActive)
    const conversation = conversationByChannel.get(channel.channel)
    const messenger = (MESSENGER_CHANNELS as readonly string[]).includes(channel.channel)
    for (const account of [...active, ...channel.accounts.filter(account => !account.isActive)]) {
      const conflicted = account.conflictState === 'conflicted'
      rows.push({
        key: `identity:${account.identityId}`,
        identityId: account.identityId,
        phoneId: account.linkedPhoneId,
        channel: channel.channel,
        channelLabel: channelLabel(channel.channel),
        account: accountLabel(account, channel.channel, phones),
        reachability: account.reachabilityStatus,
        bot: channel.channel === 'telegram' ? 'unknown' : 'not_applicable',
        preference: null,
        // With one active account the channel's conversation is that account's; otherwise the server finds the exact one.
        conversationId: account.isActive && active.length === 1 && conversation ? conversation.primaryConversationId : null,
        channelTab: Object.hasOwn(MESSENGER_CHANNEL_TABS, channel.channel) ? MESSENGER_CHANNEL_TABS[channel.channel] : null,
        writable: messenger && account.isActive && !conflicted,
        note: conflicted ? 'конфликт аккаунта — сначала разберите в «Сообщениях»' : account.isActive ? null : 'прежний аккаунт',
      })
    }
  }
  for (const phone of card.phones) {
    if (!phone.isActive || phone.lifecycle !== 'current') continue
    for (const channel of MESSENGER_CHANNELS) {
      const hasAccount = card.channels.some(entry => entry.channel === channel && entry.accounts.some(account => account.isActive && account.linkedPhoneId === phone.phoneId))
      if (hasAccount) continue
      rows.push({
        key: `phone:${phone.phoneId}:${channel}`,
        identityId: null,
        phoneId: phone.phoneId,
        channel,
        channelLabel: channelLabel(channel),
        account: formatContactPhone(phone.phone) ?? phone.phone,
        reachability: 'unknown',
        bot: channel === 'telegram' ? 'unknown' : 'not_applicable',
        preference: null,
        conversationId: null,
        channelTab: MESSENGER_CHANNEL_TABS[channel],
        writable: false,
        note: null,
      })
    }
  }
  return rows.sort((a, b) => channelOrder(a.channel) - channelOrder(b.channel))
}

const LINK_EVENT_TEXT: Record<ContactPersonCardLinkEventV1['kind'], string> = {
  contacts_merged: 'Контакты объединены',
  contacts_unmerged: 'Объединение отменено',
  merge_recovered: 'Объединение восстановлено',
  phone_added_or_verified: 'Телефон добавлен или подтверждён',
  phone_made_primary: 'Телефон сделан основным',
  phone_removed: 'Телефон отвязан',
  phone_state_changed: 'Изменено состояние телефона',
  identity_attached_to_phone: 'Аккаунт мессенджера привязан к номеру',
  driver_profile_confirmed: 'Профиль Яндекс привязан к человеку',
  communication_policy_changed: 'Изменены ограничения связи',
}
const POLICY_DETAIL_TEXT: Record<string, string> = {
  deny_all: 'запрещены все обращения', deny_message_voice: 'запрещены звонки и сообщения', deny_message: 'запрещены сообщения', deny_voice: 'запрещены звонки', none: 'ограничения сняты',
}
const CONFIRMATION_DETAIL_TEXT: Record<string, string> = {
  confirmed: '', needs_reconciliation: 'требует сверки', contradicted: 'противоречие', revoked: 'отозвано',
}

function actorText(event: ContactPersonCardLinkEventV1, staffNames: Record<string, string>): string | null {
  if (event.actor.kind === 'staff') return staffNames[event.actor.userId] ?? 'сотрудник'
  if (event.actor.kind === 'integration_admin') return 'администратор интеграций'
  if (event.actor.kind === 'system') return 'система'
  return null
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function HistoryList({ events, staffNames }: { events: ContactPersonCardLinkEventV1[]; staffNames: Record<string, string> }) {
  if (events.length === 0) return <Empty>Изменения связей пока не записаны.</Empty>
  return (
    <ul>
      {events.map((event, index) => {
        const detail = event.kind === 'communication_policy_changed' ? POLICY_DETAIL_TEXT[event.detail ?? ''] ?? null
          : event.kind === 'driver_profile_confirmed' ? CONFIRMATION_DETAIL_TEXT[event.detail ?? ''] || null : null
        const actor = actorText(event, staffNames)
        return (
          <li key={`${event.kind}-${event.at}-${index}`} className="flex flex-wrap items-center gap-2 border-b border-[#E4ECFC] px-4 py-2.5 last:border-b-0 text-[14px] text-[#0F172A]">
            <span>{LINK_EVENT_TEXT[event.kind]}{event.subject ? ` ${formatContactPhone(event.subject) ?? event.subject}` : ''}{detail ? ` — ${detail}` : ''}</span>
            {event.mode === 'manual' && <Badge tone="muted">ручное</Badge>}
            {event.mode === 'automatic' && <Badge tone="muted">авто</Badge>}
            {actor && <span className="text-[12px] text-[#64748B]">{actor}</span>}
            <span className="ml-auto text-[12px] text-[#64748B]">{formatDateTime(event.at)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ConflictLine({ conflict }: { conflict: ContactPersonCardConflictV1 }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-[14px] text-[#0F172A]">
      <span>{CONFLICT_CLASS_LABELS[conflict.conflictClass] ?? conflict.conflictClass}</span>
      <Badge tone={conflict.personBlocking ? 'bad' : 'warn'}>{conflict.personBlocking ? 'блокирует операции' : conflict.scope === 'transport_only' ? 'только транспорт' : 'открыт'}</Badge>
      {conflict.channel && <Badge tone="muted">{channelLabel(conflict.channel)}</Badge>}
      {conflict.otherContactId && <Link href={`/contacts/${encodeURIComponent(conflict.otherContactId)}`} className="text-[13px] text-[#2AABEE]">другой контакт</Link>}
    </li>
  )
}

function PhoneChip({ phone }: { phone: ContactPersonCardPhoneV1 }) {
  const lifecycle = PHONE_LIFECYCLE_LABELS[phone.lifecycle]
  const trust = PHONE_TRUST_LABELS[phone.trust]
  return (
    <span className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-[#E4ECFC] px-2 py-1 text-[13px] text-[#0F172A]">
      {formatContactPhone(phone.phone) ?? phone.phone}
      {phone.isPrimary && <Badge tone="muted">основной</Badge>}
      {lifecycle && phone.lifecycle !== 'current' && <Badge tone="muted">{lifecycle}</Badge>}
      {phone.resolutionState === 'shared' && <Badge tone="warn">используется другим контактом</Badge>}
      {phone.resolutionState === 'disputed' && <Badge tone="bad">спорный</Badge>}
      {trust && <span className="text-[12px] text-[#64748B]">{trust}</span>}
    </span>
  )
}

export default function PersonCardView({ view }: { view: ContactPersonCardViewV1 }) {
  const { card, driverProfiles, conversations, partial } = view
  const confirmation = CONFIRMATION_LABELS[card.personConfirmation.state]
  const openConflicts = card.conflicts.filter(conflict => conflict.status === 'open')
  const rows = messengerRows(view)
  const activeAccounts = card.channels.reduce((sum, channel) => sum + channel.accounts.filter(account => account.isActive).length, 0)
  const currentPhones = card.phones.filter(phone => phone.isActive && phone.lifecycle !== 'removed' && phone.lifecycle !== 'superseded')
  const anyActive = driverProfiles.some(profile => profileStatus(profile).tone === 'active')
  const cardConversations: CardConversationV1[] = conversations.map(conversation => ({
    channel: conversation.channel,
    channelLabel: channelLabel(conversation.channel),
    conversationId: conversation.primaryConversationId,
    channelTab: Object.hasOwn(MESSENGER_CHANNEL_TABS, conversation.channel) ? MESSENGER_CHANNEL_TABS[conversation.channel] : null,
    count: conversation.conversationCount,
  }))
  return (
    <div className="w-full space-y-4">
      <header className="rounded-xl border border-[#E4ECFC] bg-white px-5 py-4">
        <h1 className="text-[22px] font-semibold text-[#0F172A]">{card.displayName}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          {anyActive && <Badge tone="ok">Активный водитель</Badge>}
          <Badge tone={confirmation.tone}>{confirmation.text}</Badge>
          <Badge tone="muted">{driverProfiles.length} {pluralRu(driverProfiles.length, 'профиль', 'профиля', 'профилей')}</Badge>
          <Badge tone="muted">{currentPhones.length} {pluralRu(currentPhones.length, 'телефон', 'телефона', 'телефонов')}</Badge>
          <Badge tone="muted">{activeAccounts} {pluralRu(activeAccounts, 'мессенджер', 'мессенджера', 'мессенджеров')}</Badge>
          {card.personConfirmation.state === 'confirmed' && card.personConfirmation.confirmedPersonName && card.personConfirmation.confirmedPersonName !== card.displayName && (
            <Badge tone="muted">в парке: {card.personConfirmation.confirmedPersonName}</Badge>
          )}
          {card.automation.doNotMerge && <Badge tone="muted">объединение запрещено</Badge>}
          {card.automation.canonicalPinned && <Badge tone="muted">имя закреплено вручную</Badge>}
          {card.lineage.mergedFromCount > 0 && <Badge tone="muted">объединено записей: {card.lineage.mergedFromCount}</Badge>}
        </div>
        {(openConflicts.length > 0 || card.candidates.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="text-[13px] font-medium text-amber-800">Требует внимания</div>
            <ul className="mt-1 space-y-1">
              {openConflicts.map((conflict, index) => <ConflictLine key={`${conflict.origin}-${conflict.identityId ?? 'contact'}-${index}`} conflict={conflict} />)}
              {card.candidates.map(candidate => (
                <li key={candidate.contactId} className="text-[14px] text-[#0F172A]">
                  Возможно тот же человек — не подтверждено ({CANDIDATE_BASIS_LABELS[candidate.basis] ?? candidate.basis}):{' '}
                  <Link href={`/contacts/${encodeURIComponent(candidate.contactId)}`} className="text-[#2AABEE]">открыть карточку</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <Section title="Парки и занятость" count={driverProfiles.length}>
        {partial.driverProfiles && <Empty>Данные парков сейчас недоступны. Показано только то, что известно Contacts.</Empty>}
        {!partial.driverProfiles && driverProfiles.length === 0 && <Empty>Связанных водительских профилей нет.</Empty>}
        {!partial.driverProfiles && driverProfiles.length > 0 && <ParksTable profiles={driverProfiles} />}
      </Section>

      <Section title="Мессенджеры" count={activeAccounts}>
        {partial.conversations && <Empty>Переписки сейчас недоступны: «Написать» откроет переписку через сервер.</Empty>}
        <MessengersTable contactId={card.contactId} rows={rows} />
      </Section>

      {/* Calling's own block: the server decides who may be called and how; the card only hosts it. */}
      <AiConversationPanel contactId={card.contactId} />

      <Section title="Действия и управление">
        {currentPhones.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-1">
            {card.phones.map(phone => <PhoneChip key={phone.phoneId} phone={phone} />)}
          </div>
        )}
        <CardActions contactId={card.contactId} displayName={card.displayName} conversations={cardConversations} />
      </Section>

      <Section title="История связей" count={card.linkHistory.length}>
        <HistoryList events={card.linkHistory} staffNames={view.staffNames ?? {}} />
      </Section>
    </div>
  )
}
