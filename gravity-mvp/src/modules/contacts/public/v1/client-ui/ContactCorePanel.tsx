"use client"

// M3A1 Contact core panel — the first Contacts-owned public client surface, and
// the Contact-owned part of the future Contact Card.
//
// It renders one ContactCardSummary.v1 and nothing else. It fetches nothing,
// probes nothing and imports no database client, no foreign domain and no
// provider: every fact it can show is a fact Contacts owns. Conversations,
// delivery status, live reachability, provider readiness, calls, tasks and
// driver data belong to their own domains' panels, which the platform shell will
// compose beside this one in a later slice.

import type { ContactCardChannelSummaryV1, ContactCardSummaryV1 } from '../contact-card-summary'

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  max: 'MAX',
  avito: 'Avito',
  phone: 'Телефон',
}

const SOURCE_LABELS: Record<string, string> = {
  chat: 'Из переписки',
  yandex: 'Яндекс.Парк',
  manual: 'Вручную',
  avito: 'Avito',
  import: 'Импорт',
}

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

function ChannelRow({ channel }: { channel: ContactCardChannelSummaryV1 }) {
  const conflicted = channel.conflictState === 'conflicted'
  return (
    <li
      data-testid={`contact-core-channel-${channel.channel}`}
      className="flex items-center justify-between gap-2 py-1"
    >
      <span className="text-[12px] text-[#111]">{channelLabel(channel.channel)}</span>
      <span className="flex items-center gap-1.5">
        {channel.identityCount > 1 && (
          <span className="text-[11px] text-gray-500">{channel.identityCount}</span>
        )}
        {/* Presence only: this says a channel identity exists, never that a
            message will arrive. Deliverability belongs to Messaging. */}
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
            channel.hasActiveIdentity ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {channel.hasActiveIdentity ? 'Идентичность есть' : 'Неактивна'}
        </span>
        {conflicted && (
          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
            Конфликт
          </span>
        )}
      </span>
    </li>
  )
}

export default function ContactCorePanel({ summary }: { summary: ContactCardSummaryV1 }) {
  return (
    <section aria-label="Контакт" data-testid="contact-core-panel" className="space-y-3 px-3 py-2.5">
      <header className="space-y-0.5">
        <h3 data-testid="contact-core-title" className="text-[13px] font-semibold text-[#111]">
          {summary.displayTitle}
        </h3>
        <p data-testid="contact-core-primary-phone" className="text-[12px] text-gray-500">
          {summary.primaryPhone ?? 'Телефон не указан'}
        </p>
      </header>

      <div className="space-y-1">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Каналы</h4>
        {summary.channels.length === 0 ? (
          <p data-testid="contact-core-channels-empty" className="text-[12px] text-gray-500">
            Идентичностей каналов нет
          </p>
        ) : (
          <ul data-testid="contact-core-channels" className="divide-y divide-[#F0F0F0]">
            {summary.channels.map(channel => (
              <ChannelRow key={channel.channel} channel={channel} />
            ))}
          </ul>
        )}
      </div>

      {summary.hasIdentityConflict && (
        <p
          role="status"
          data-testid="contact-core-identity-conflict"
          className="rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900"
        >
          Есть конфликт идентичности канала — требуется проверка.
        </p>
      )}

      <dl className="space-y-0.5 text-[12px]">
        <div className="flex justify-between">
          <dt className="text-gray-500">Телефонов</dt>
          <dd data-testid="contact-core-phone-count" className="font-medium text-[#111]">
            {summary.phoneCount}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Источник</dt>
          <dd data-testid="contact-core-source" className="font-medium text-[#111]">
            {sourceLabel(summary.source)}
          </dd>
        </div>
        {summary.lineage.mergedFromCount > 0 && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Объединено карточек</dt>
            <dd data-testid="contact-core-merged-from" className="font-medium text-[#111]">
              {summary.lineage.mergedFromCount}
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}
