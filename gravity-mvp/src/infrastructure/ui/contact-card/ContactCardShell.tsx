'use client'

// M3A2 Contact Card shell: platform_shell UI composition for the Messaging
// host's opt-in card mode (`?profile=1&card=1`).
//
// The host hands over the persisted Chat.id and a close callback, nothing else.
// The shell asks the server composition what to show and renders the
// Contacts-owned ContactCorePanel only for a resolved Contact. Every other answer
// is an explicit state: an unresolved, ambiguous or unknown conversation is never
// turned into a guessed Contact. The shell fetches nothing itself, probes
// nothing, writes nothing and polls nothing; a failed load offers one manual
// retry. Later panels are composed here explicitly, beside the core.

import { Component, useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

import ContactCorePanel from '@/modules/contacts/public/v1/client-ui/ContactCorePanel'
import { loadContactCardForConversationV1, type ContactCardLoadResultV1 } from './contact-card-actions'

type LoadedCard = { chatId: string; attempt: number; result: ContactCardLoadResultV1 }

/** Keeps one panel's render failure inside its slot, so the host and the header survive it. */
class PanelErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(err: unknown) {
    console.error('[contact-card] panel render failed:', err instanceof Error ? err.message : err)
  }

  render() {
    if (this.state.failed) {
      return <CardMessage testId="contact-card-panel-failed" title="Не удалось показать раздел" />
    }
    return this.props.children
  }
}

function CardMessage({ testId, title, detail, children }: {
  testId: string
  title: string
  detail?: string
  children?: ReactNode
}) {
  return (
    <div role="status" data-testid={testId} className="space-y-1 px-3 py-4 text-center">
      <p className="text-[13px] font-semibold text-[#111]">{title}</p>
      {detail && <p className="text-[12px] text-gray-500">{detail}</p>}
      {children}
    </div>
  )
}

export default function ContactCardShell({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<LoadedCard | null>(null)

  useEffect(() => {
    // Only the newest request for the conversation on screen may land: a
    // switch, a retry or closing the card discards the answer still in flight.
    let current = true
    loadContactCardForConversationV1(chatId).then(
      (result) => { if (current) setLoaded({ chatId, attempt, result }) },
      () => { if (current) setLoaded({ chatId, attempt, result: { status: 'failed' } }) },
    )
    return () => { current = false }
  }, [chatId, attempt])

  // A result is shown only for the conversation and attempt it was loaded for.
  const result = loaded !== null && loaded.chatId === chatId && loaded.attempt === attempt ? loaded.result : null

  return (
    <aside
      aria-label="Карточка контакта"
      data-testid="contact-card-shell"
      className="w-[280px] bg-white border-l border-[#E8E8E8] shrink-0 h-full flex flex-col"
    >
      <div className="h-[44px] border-b border-[#E8E8E8] flex items-center justify-between px-[4px] shrink-0">
        <span className="text-[13px] font-semibold text-[#111]">Контакт</span>
        <button
          type="button"
          aria-label="Закрыть"
          onClick={onClose}
          className="w-6 h-6 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {result === null && (
          <div role="status" aria-label="Загрузка контакта" data-testid="contact-card-loading" className="space-y-2 px-3 py-3">
            <div className="h-4 w-2/3 rounded bg-[#F1F5FD] animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-[#F1F5FD] animate-pulse" />
          </div>
        )}
        {result?.status === 'resolved' && (
          <PanelErrorBoundary>
            <ContactCorePanel summary={result.summary} />
          </PanelErrorBoundary>
        )}
        {result?.status === 'unresolved' && (
          <CardMessage testId="contact-card-unresolved" title="Контакт не определён" detail="Чат не связан с контактом." />
        )}
        {result?.status === 'ambiguous' && (
          <CardMessage
            testId="contact-card-ambiguous"
            title="Контакт неоднозначен"
            detail="Чат соответствует нескольким людям, поэтому контакт не выбран."
          />
        )}
        {result?.status === 'not_found' && (
          <CardMessage testId="contact-card-chat-not-found" title="Чат не найден" />
        )}
        {result?.status === 'contact_not_found' && (
          <CardMessage testId="contact-card-contact-not-found" title="Контакт не найден" />
        )}
        {result?.status === 'failed' && (
          <CardMessage testId="contact-card-failed" title="Не удалось загрузить контакт">
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="mt-2 text-[12px] font-medium text-[#2AABEE] hover:text-[#1E96D4]"
            >
              Повторить
            </button>
          </CardMessage>
        )}
      </div>
    </aside>
  )
}
