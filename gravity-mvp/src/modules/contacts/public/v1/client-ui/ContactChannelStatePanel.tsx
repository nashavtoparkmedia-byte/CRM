"use client"

// M3A4 S1 Contact channel-state panel — the second Contacts-owned public client
// surface, beside ContactCorePanel.
//
// It renders one ContactIdentityConflictView.v1 and nothing else. It fetches
// nothing, probes nothing, offers no resolution action and imports no database
// client, no foreign domain and no provider. Read-only on purpose: no
// authoritative Contacts command closes an identity conflict, so a button that
// looked like it did would be a lie.
//
// The four states the Contact Card is allowed to distinguish stay distinct here:
// an identity EXISTING is ContactCorePanel's job; an identity being CONFLICTED is
// this panel's; provider or runtime unavailability belongs to the channel
// domains' own panels; and delivery failure belongs to Messaging. This panel
// never says "канал недоступен".

import type {
  ContactIdentityConflictViewEntryV1,
  ContactIdentityConflictViewV1,
} from '../contact-identity-conflict-view'

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  max: 'MAX',
  avito: 'Avito',
  phone: 'Телефон',
}

const CONFLICT_CLASS_LABELS: Record<string, string> = {
  channel_identity_collision: 'Конфликт идентичности канала',
  provider_identity_alias_collision: 'Совпадение псевдонимов идентичности',
  stable_identity_phone_contradiction: 'Противоречие телефона и идентичности',
  confirmed_driver_cluster_contradiction: 'Противоречие подтверждения водителя',
  fleet_authoritative_person_contradiction: 'Противоречие данных парка о человеке',
  identity_conflict_flag: 'Идентичность отмечена как конфликтная',
  unknown: 'Неизвестный конфликт',
}

const IDENTITY_STATE_NOTES: Record<string, string> = {
  inactive: 'идентичность неактивна',
  missing: 'идентичность удалена',
  contact: 'относится к карточке целиком',
}

function channelLabel(channel: string | null): string {
  if (channel === null) return 'Без канала'
  return CHANNEL_LABELS[channel] ?? channel
}

function conflictClassLabel(conflictClass: string): string {
  return CONFLICT_CLASS_LABELS[conflictClass] ?? CONFLICT_CLASS_LABELS.unknown
}

function ConflictRow({ conflict }: { conflict: ContactIdentityConflictViewEntryV1 }) {
  const note = IDENTITY_STATE_NOTES[conflict.identityState] ?? null
  return (
    <li
      data-testid={`contact-conflict-${conflict.channel ?? 'none'}-${conflict.conflictClass}`}
      className="flex items-start justify-between gap-2 py-1"
    >
      <span className="flex flex-col">
        <span className="text-[12px] text-[#111]">{conflictClassLabel(conflict.conflictClass)}</span>
        <span className="text-[11px] text-gray-500">
          {channelLabel(conflict.channel)}
          {note === null ? '' : ` · ${note}`}
        </span>
      </span>
      {/* Blocking is the only actionable distinction the card may draw. A
          transport-only conflict failed one transport and must not read as if the
          person were unreachable. */}
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
          conflict.blocksPersonOperations
            ? 'bg-amber-50 text-amber-700'
            : 'bg-gray-100 text-gray-500'
        }`}
      >
        {conflict.blocksPersonOperations ? 'Требуется проверка' : 'Не блокирует'}
      </span>
    </li>
  )
}

export default function ContactChannelStatePanel({ view }: { view: ContactIdentityConflictViewV1 }) {
  return (
    <section
      aria-label="Состояние идентичности"
      data-testid="contact-channel-state-panel"
      className="space-y-2 px-3 py-2.5"
    >
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Идентичность</h4>

      {view.conflicts.length === 0 ? (
        <p data-testid="contact-conflicts-empty" className="text-[12px] text-gray-500">
          Конфликтов идентичности нет
        </p>
      ) : (
        <>
          <p
            role="status"
            data-testid="contact-conflict-headline"
            className={`rounded-lg px-2 py-1.5 text-[11px] leading-4 ${
              view.hasPersonBlockingConflict
                ? 'bg-amber-50 text-amber-900'
                : 'bg-gray-50 text-gray-600'
            }`}
          >
            {view.hasPersonBlockingConflict
              ? 'Есть конфликт идентичности — требуется проверка.'
              : 'Есть конфликт транспорта — операции не заблокированы.'}
          </p>
          <ul data-testid="contact-conflicts" className="divide-y divide-[#F0F0F0]">
            {view.conflicts.map((conflict, index) => (
              <ConflictRow key={`${conflict.identityId ?? 'contact'}-${conflict.conflictClass}-${index}`} conflict={conflict} />
            ))}
          </ul>
        </>
      )}

      {view.closedConflictCount > 0 && (
        <p data-testid="contact-conflicts-closed" className="text-[11px] text-gray-400">
          Ранее устранённых: {view.closedConflictCount}
        </p>
      )}
    </section>
  )
}
