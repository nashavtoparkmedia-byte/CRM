import { describe, expect, it } from 'vitest'

import { cn } from './class-names'

describe('shared class-name composition', () => {
  it('keeps conditional classes and resolves Tailwind conflicts', () => {
    expect(cn('px-2 text-red-500', false && 'hidden', ['font-medium', 'px-4'])).toBe(
      'text-red-500 font-medium px-4',
    )
  })
})
