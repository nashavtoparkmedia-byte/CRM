import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PageContainer as LegacyPageContainer } from '@/components/ui/PageContainer'
import {
  Button as LegacyButton,
  buttonVariants as legacyButtonVariants,
} from '@/components/ui/button'
import { PageShell as LegacyPageShell } from '@/components/layout/PageShell'
import { PageContainer } from './PageContainer'
import { Button, buttonVariants } from './button'
import { PageShell } from './PageShell'

describe('shared UI infrastructure compatibility', () => {
  it('keeps legacy paths as exact aliases of the relocated implementations', () => {
    expect(LegacyPageContainer).toBe(PageContainer)
    expect(LegacyButton).toBe(Button)
    expect(legacyButtonVariants).toBe(buttonVariants)
    expect(LegacyPageShell).toBe(PageShell)
  })

  it('preserves PageContainer markup and Button variants', () => {
    const markup = renderToStaticMarkup(<PageContainer><span>content</span></PageContainer>)
    expect(markup).toContain('max-w-[1400px]')
    expect(markup).toContain('<span>content</span>')
    expect(buttonVariants({ variant: 'destructive', size: 'icon' })).toContain('bg-destructive')
    expect(buttonVariants({ variant: 'destructive', size: 'icon' })).toContain('h-10 w-10')
  })
})
