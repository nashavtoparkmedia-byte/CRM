import { describe, expect, it } from 'vitest'

import { PageHeader as LegacyPageHeader } from '@/components/layout/PageHeader'
import { SectionDescription as LegacySectionDescription } from '@/components/ui/SectionDescription'
import { Badge as LegacyBadge, badgeVariants as legacyBadgeVariants } from '@/components/ui/badge'
import {
  Card as LegacyCard,
  CardContent as LegacyCardContent,
  CardDescription as LegacyCardDescription,
  CardFooter as LegacyCardFooter,
  CardHeader as LegacyCardHeader,
  CardTitle as LegacyCardTitle,
} from '@/components/ui/card'
import {
  Dialog as LegacyDialog,
  DialogContent as LegacyDialogContent,
  DialogTrigger as LegacyDialogTrigger,
} from '@/components/ui/dialog'
import { Input as LegacyInput } from '@/components/ui/input'
import { Table as LegacyTable, TableRow as LegacyTableRow } from '@/components/ui/table'
import { Tabs as LegacyTabs, TabsContent as LegacyTabsContent } from '@/components/ui/tabs'
import { Tooltip as LegacyTooltip, TooltipContent as LegacyTooltipContent } from '@/components/ui/tooltip'
import { PageHeader } from './PageHeader'
import { SectionDescription } from './SectionDescription'
import { Badge, badgeVariants } from './badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card'
import { Dialog, DialogContent, DialogTrigger } from './dialog'
import { Input } from './input'
import { Table, TableRow } from './table'
import { Tabs, TabsContent } from './tabs'
import { Tooltip, TooltipContent } from './tooltip'

describe('relocated shared UI primitive compatibility', () => {
  it('keeps every legacy path as an exact alias', () => {
    expect(LegacyPageHeader).toBe(PageHeader)
    expect(LegacySectionDescription).toBe(SectionDescription)
    expect(LegacyInput).toBe(Input)
    expect(LegacyBadge).toBe(Badge)
    expect(legacyBadgeVariants).toBe(badgeVariants)
    expect(LegacyDialog).toBe(Dialog)
    expect(LegacyDialogContent).toBe(DialogContent)
    expect(LegacyDialogTrigger).toBe(DialogTrigger)
    expect(LegacyTable).toBe(Table)
    expect(LegacyTableRow).toBe(TableRow)
    expect(LegacyTooltip).toBe(Tooltip)
    expect(LegacyTooltipContent).toBe(TooltipContent)
    expect(LegacyCard).toBe(Card)
    expect(LegacyCardHeader).toBe(CardHeader)
    expect(LegacyCardTitle).toBe(CardTitle)
    expect(LegacyCardDescription).toBe(CardDescription)
    expect(LegacyCardContent).toBe(CardContent)
    expect(LegacyCardFooter).toBe(CardFooter)
    expect(LegacyTabs).toBe(Tabs)
    expect(LegacyTabsContent).toBe(TabsContent)
  })
})
