import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

import ContactResolutionAmbiguityBanner from './ContactResolutionAmbiguityBanner'

describe('ContactResolutionAmbiguityBanner', () => {
  test('renders ambiguity count, no-auto-link statement and manual resolution action', () => {
    const html = renderToStaticMarkup(
      <ContactResolutionAmbiguityBanner candidateCount={3} onManualSearch={vi.fn()} />,
    )

    expect(html).toContain('Не удалось автоматически связать контакт')
    expect(html).toContain('Найдено подходящих карточек: 3')
    expect(html).toContain('Автоматическая привязка не выполнена')
    expect(html).toContain('Найти и привязать вручную')
    expect(html).toContain('объединение')
  })

  test('does not expose internal candidate identifiers', () => {
    const html = renderToStaticMarkup(
      <ContactResolutionAmbiguityBanner candidateCount={2} onManualSearch={vi.fn()} />,
    )
    expect(html).not.toContain('contactId')
    expect(html).not.toContain('candidateContactIds')
  })
})
