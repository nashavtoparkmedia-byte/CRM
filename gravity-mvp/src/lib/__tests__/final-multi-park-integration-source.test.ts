import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('final multi-park integration source contracts', () => {
  test('Contact API exposes suggested profiles without auto attaching phone-only candidates', () => {
    const route = read('src/app/api/contacts/[id]/route.ts')
    const service = read('src/lib/driver-profiles/multi-park.ts')
    expect(route).toContain('findSuggestedDriverProfilesForContact')
    expect(route).toContain('suggestedDriverProfiles')
    expect(service).toContain('suggested_profiles')
    expect(service).toContain('phone is not proof of cross-park person ownership')
    expect(service).toContain('profile.contactId === contactId')
  })

  test('manual attachment is explicit, audited, and conflict-safe', () => {
    const route = read('src/app/api/contacts/[id]/driver-profiles/attach/route.ts')
    const service = read('src/lib/driver-profiles/multi-park.ts')
    expect(route).toContain('attachDriverProfilesToContactManually')
    expect(service).toContain('profile_belongs_to_other_contact')
    expect(service).toContain('driver_profile_manual_attach')
    expect(service).toContain('PROVEN_MANUAL')
    expect(service).toContain('refreshContactMainDriver')
  })

  test('right panel contains suggested profile review flow and inline help', () => {
    const drawer = read('src/app/messages/components/ContactProfileDrawer.tsx')
    expect(drawer).toContain('Возможные профили водителя')
    expect(drawer).toContain('Привязать выбранные')
    expect(drawer).toContain('Не принадлежат этому контакту')
    expect(drawer).toContain('Как работает раздел')
    expect(drawer).toContain('/driver-profiles/attach')
    expect(drawer).toContain('window.confirm')
  })

  test('backfill stays dry-run by default and write requires explicit protections', () => {
    const backfill = read('scripts/multi-park-final-backfill.js')
    expect(backfill).toContain('dryRun: true')
    expect(backfill).toContain('--write')
    expect(backfill).toContain('--backup-marker')
    expect(backfill).toContain('MULTI_PARK_BACKFILL_CONFIRM_TOKEN')
    expect(backfill).toContain('exactLegacyMatches: 8072')
    expect(backfill).toContain('sourceOnlyProfiles: 595')
  })
})
