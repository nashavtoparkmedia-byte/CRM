"use client"

// M3A6B ContactSelector — the reusable Contacts-owned picker for "which Contact
// did the operator select?".
//
// It is the client presentation of ContactLookup.v1 and nothing more. It does not
// decide whether a Contact can be messaged, which channel to use, whether a
// provider is online, which Chat belongs to the Contact, or whether communication
// is permitted. A channel name under a result says only that the Contact owns an
// active Contacts identity on that channel.
//
// It owns no transport. The caller injects `lookup`, so the selector is testable
// without a network and a future integration slice can supply any thin transport
// without changing selection semantics. Query validity, ranking, ordering and the
// limit all belong to ContactLookup.v1: the selector asks contactLookupCriteriaV1
// whether a query may be sent and renders results in exactly the order received.
//
// Only a concrete ContactLookupItemV1 can become the selection. Typed text never
// does, Enter on no highlighted option selects nothing, and Blur or Tab never
// auto-select. The canonical identity of a selection is `value.contactId`; the
// other fields are a display snapshot so the controlled input can show what was
// chosen without an id-to-display lookup of its own.

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import {
  contactLookupCriteriaV1,
  type ContactLookupItemV1,
  type ContactLookupResultV1,
} from '../contact-lookup'

/** The injected transport for ContactLookup.v1. */
export type ContactLookupClientV1 = (input: { query: string; limit?: number }) => Promise<ContactLookupResultV1>

export type ContactSelectorPropsV1 = {
  /** The accessible name of the picker, e.g. "Контакт для объединения". */
  label: string
  lookup: ContactLookupClientV1
  /** The committed selection. Persist `value.contactId`, never the whole item. */
  value: ContactLookupItemV1 | null
  onChange: (value: ContactLookupItemV1 | null) => void
  placeholder?: string
  disabled?: boolean
}

/** A fixed operator-picker debounce, matching the existing contact search hook. */
export const CONTACT_SELECTOR_DEBOUNCE_MS = 300

// Presentation only: a translation of the channel enum, never a capability claim.
const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  max: 'MAX',
  avito: 'Avito',
  phone: 'Телефон',
}

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel
}

type LookupStatus = 'idle' | 'loading' | 'success' | 'error'

export default function ContactSelector({
  label,
  lookup,
  value,
  onChange,
  placeholder,
  disabled = false,
}: ContactSelectorPropsV1) {
  const baseId = useId()
  const inputId = `${baseId}-input`
  const labelId = `${baseId}-label`
  const listboxId = `${baseId}-listbox`
  const optionId = (index: number) => `${baseId}-option-${index}`

  const [inputText, setInputText] = useState(value?.displayTitle ?? '')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<LookupStatus>('idle')
  const [result, setResult] = useState<ContactLookupResultV1 | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [announcement, setAnnouncement] = useState('')

  const inputRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Every query, selection and clear takes a new number; a completion is applied
  // only if its number is still the latest. Transport cancellation is not relied
  // upon, because an injected lookup need not support it.
  const sequenceRef = useRef(0)
  const mountedRef = useRef(true)
  const committedTitleRef = useRef<string | null>(value?.displayTitle ?? null)

  const items = result?.items ?? []

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    sequenceRef.current += 1
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelPending()
    }
  }, [cancelPending])

  // Follow a controlled value. A newly committed item shows its title; a value
  // cleared from outside clears the text only if the operator had not already
  // started typing something else, so an onChange(null) echo never erases input.
  useEffect(() => {
    if (value !== null) {
      committedTitleRef.current = value.displayTitle
      setInputText(value.displayTitle)
      return
    }
    setInputText(current => (committedTitleRef.current !== null && current === committedTitleRef.current ? '' : current))
    committedTitleRef.current = null
  }, [value])

  const resetLookup = useCallback(() => {
    cancelPending()
    setStatus('idle')
    setResult(null)
    setActiveIndex(-1)
    setOpen(false)
  }, [cancelPending])

  const runLookup = useCallback((query: string, sequence: number) => {
    let pending: Promise<ContactLookupResultV1>
    try {
      pending = Promise.resolve(lookup({ query }))
    } catch {
      pending = Promise.reject(new Error('lookup failed'))
    }
    pending.then(
      (received) => {
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        const receivedItems = Array.isArray(received?.items) ? received.items : []
        setResult({ items: receivedItems, total: receivedItems.length, truncated: received?.truncated === true })
        setStatus('success')
        setActiveIndex(-1)
        setAnnouncement(receivedItems.length === 0
          ? 'Контакты не найдены'
          : `Найдено контактов: ${receivedItems.length}`)
      },
      () => {
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        // The cause is deliberately not rendered: a server message is not
        // operator text, and the committed selection is left untouched.
        setResult(null)
        setStatus('error')
        setActiveIndex(-1)
        setAnnouncement('')
      },
    )
  }, [lookup])

  const handleTextChange = (text: string) => {
    if (disabled) return
    // Editing away from a committed selection un-commits it first: the text is
    // only a query from here on, never a selected Contact.
    if (value !== null && text !== value.displayTitle) {
      committedTitleRef.current = null
      onChange(null)
    }
    setInputText(text)
    resetLookup()
    if (contactLookupCriteriaV1(text) === null) return
    const sequence = sequenceRef.current
    setStatus('loading')
    setOpen(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runLookup(text, sequence)
    }, CONTACT_SELECTOR_DEBOUNCE_MS)
  }

  const select = (item: ContactLookupItemV1) => {
    resetLookup()
    committedTitleRef.current = item.displayTitle
    setInputText(item.displayTitle)
    setAnnouncement('')
    onChange(item)
  }

  const clear = () => {
    resetLookup()
    committedTitleRef.current = null
    setInputText('')
    setAnnouncement('')
    onChange(null)
    inputRef.current?.focus()
  }

  // Keep the highlighted option visible while navigating by keyboard.
  useEffect(() => {
    if (activeIndex < 0 || typeof document === 'undefined') return
    document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, baseId])

  const listVisible = open && !disabled && status === 'success' && items.length > 0

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return
    switch (event.key) {
      case 'ArrowDown': {
        if (items.length === 0) return
        event.preventDefault()
        setOpen(true)
        setActiveIndex(current => (current < 0 ? 0 : Math.min(current + 1, items.length - 1)))
        return
      }
      case 'ArrowUp': {
        if (items.length === 0) return
        event.preventDefault()
        setOpen(true)
        setActiveIndex(current => (current < 0 ? items.length - 1 : Math.max(current - 1, 0)))
        return
      }
      case 'Home': {
        if (!listVisible) return
        event.preventDefault()
        setActiveIndex(0)
        return
      }
      case 'End': {
        if (!listVisible) return
        event.preventDefault()
        setActiveIndex(items.length - 1)
        return
      }
      case 'Enter': {
        // Only a concrete highlighted option can be selected.
        if (!listVisible) return
        event.preventDefault()
        if (activeIndex >= 0 && activeIndex < items.length) select(items[activeIndex])
        return
      }
      case 'Escape': {
        if (!open) return
        event.preventDefault()
        setOpen(false)
        setActiveIndex(-1)
        return
      }
      default:
        // Tab and everything else keep their native behaviour; nothing is selected.
        return
    }
  }

  const activeDescendant = listVisible && activeIndex >= 0 ? optionId(activeIndex) : undefined

  return (
    <div className="relative" data-testid="contact-selector">
      <label id={labelId} htmlFor={inputId} className="mb-1 block text-[13px] font-medium text-[#0F172A]">
        {label}
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listVisible}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          autoComplete="off"
          disabled={disabled}
          value={inputText}
          placeholder={placeholder}
          onChange={event => handleTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setOpen(false)
            setActiveIndex(-1)
          }}
          className="h-[44px] w-full rounded-[8px] border border-[#E4ECFC] bg-white px-3 pr-10 text-[15px] text-[#0F172A] outline-none placeholder:text-[#64748B] focus:border-[#2AABEE] disabled:bg-[#F1F5FD] disabled:text-[#64748B]"
        />
        {inputText !== '' && !disabled && (
          <button
            type="button"
            aria-label="Очистить выбор контакта"
            onClick={clear}
            className="absolute right-1 top-1/2 flex h-[36px] w-[36px] -translate-y-1/2 items-center justify-center rounded-full text-[#64748B] hover:bg-[#F1F5FD]"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>

      <ul
        id={listboxId}
        role="listbox"
        aria-labelledby={labelId}
        hidden={!listVisible}
        className="mt-1 max-h-[280px] overflow-y-auto rounded-[12px] border border-[#E4ECFC] bg-white"
      >
        {listVisible && items.map((item, index) => (
          <li
            key={`${index}-${item.contactId}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            // Keep focus on the input so a pointer selection is not lost to blur.
            onMouseDown={event => event.preventDefault()}
            onClick={() => select(item)}
            className={`flex min-h-[56px] cursor-pointer flex-col justify-center px-3 py-2 ${
              index === activeIndex ? 'bg-[#F1F5FD]' : 'hover:bg-[#F1F5FD]'
            }`}
          >
            <span className="truncate text-[15px] font-medium text-[#0F172A]">{item.displayTitle}</span>
            {Array.isArray(item.channels) && item.channels.length > 0 && (
              <span className="truncate text-[12px] text-[#64748B]">
                {item.channels.map(channelLabel).join(' · ')}
              </span>
            )}
          </li>
        ))}
      </ul>

      {open && !disabled && status === 'loading' && (
        <p data-testid="contact-selector-loading" className="mt-1 px-3 py-2 text-[13px] text-[#64748B]">
          Поиск…
        </p>
      )}
      {open && !disabled && status === 'success' && items.length === 0 && (
        <p data-testid="contact-selector-empty" className="mt-1 px-3 py-2 text-[13px] text-[#64748B]">
          Контакты не найдены
        </p>
      )}
      {listVisible && result?.truncated === true && (
        <p data-testid="contact-selector-truncated" className="mt-1 px-3 py-1 text-[12px] text-[#64748B]">
          Показаны первые результаты — уточните поиск.
        </p>
      )}
      {open && !disabled && status === 'error' && (
        <p role="alert" data-testid="contact-selector-error" className="mt-1 px-3 py-2 text-[13px] text-[#DC2626]">
          Не удалось выполнить поиск контактов.
        </p>
      )}

      <div role="status" aria-live="polite" className="sr-only" data-testid="contact-selector-status">
        {announcement}
      </div>
    </div>
  )
}
