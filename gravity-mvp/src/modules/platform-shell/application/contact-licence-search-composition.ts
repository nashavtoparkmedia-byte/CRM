// Platform-shell composition (application layer) of the «Люди» search by an
// exact driving licence (ВУ) (Owner D2, OD-03).
//
// Two reads, each owned by its own context, composed here and nowhere else:
//   1. Contacts' ContactReadAuthorityQuery.v1 — whether the caller may read
//      people at all, and the ВУ view they hold (full for Администратор, the last
//      four characters for everyone else). Nothing else is read before it allows.
//   2. Fleet Operations' DriverProfilesByExactLicenceQuery.v1 — the persisted
//      park profiles whose ВУ is exactly the typed one, each ВУ masked by Fleet on
//      the server for that view.
// The typed licence goes to Fleet and nowhere else: it is not returned, not
// logged and not quoted in an error. An answer with a shown ВУ that is not
// masked for a last-4 reader is withheld as a whole. The answer reports which
// Contact each row's own stored link points at; it decides no person.
import {
  DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1,
  DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1,
  type DriverProfilesByExactLicenceResultV1,
} from '@/contracts/fleet-operations/v1'
import { resolveContactReadAuthorityV1, type ContactReadAuthorityV1 } from '@/modules/contacts/public/v1'
import { DRIVER_LICENCE_MASK_V1, findDriverProfilesByExactLicenceV1 } from '@/modules/fleet-operations/public/v1'

export type ContactLicenceSearchProfileV1 = {
  driverId: string
  /** The Contact the Driver row's own stored link points at, or null: a stored link, not a person decision. */
  linkedContactId: string | null
  fullName: string
  parkName: string | null
  /** The stored ВУ as the caller's view allows: full, or «•••• 5678». */
  licence: string | null
  dismissedAt: string | null
}

export type ContactLicenceSearchResultV1 =
  | { status: 'denied' }
  | { status: 'invalid' }
  | { status: 'unavailable' }
  | { status: 'answered'; profiles: ContactLicenceSearchProfileV1[]; truncated: boolean }

export type ContactLicenceSearchCompositionDependenciesV1 = {
  resolveReadAuthority: () => Promise<ContactReadAuthorityV1>
  findDriverProfilesByExactLicence: (query: unknown) => Promise<DriverProfilesByExactLicenceResultV1>
}

/** Under a last-4 view a shown ВУ is either absent or starts with Fleet's mask. */
function maskedForView(licence: string | null, licenceView: 'full' | 'last4'): boolean {
  return licenceView === 'full' || licence === null || licence.startsWith(DRIVER_LICENCE_MASK_V1)
}

export function createContactLicenceSearchCompositionV1(deps: ContactLicenceSearchCompositionDependenciesV1) {
  return async function searchPeopleByExactLicenceV1(licence: unknown): Promise<ContactLicenceSearchResultV1> {
    const authority = await deps.resolveReadAuthority()
    if (authority.decision !== 'allow') return { status: 'denied' }
    if (typeof licence !== 'string' || licence.length > DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1) return { status: 'invalid' }
    const licenceView = authority.licenceView === 'full' ? 'full' : 'last4'
    let answer: DriverProfilesByExactLicenceResultV1
    try {
      answer = await deps.findDriverProfilesByExactLicence({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence, licenceView })
    } catch (error) {
      // Only the error class: neither the typed licence nor any message is logged.
      console.error('[contact-licence-search] Fleet read failed:', error instanceof Error ? error.name : 'unknown')
      return { status: 'unavailable' }
    }
    if (!answer.profiles.every(profile => maskedForView(profile.licence, licenceView))) {
      console.error('[contact-licence-search] Fleet answered an unmasked ВУ for a last-4 reader; answer withheld')
      return { status: 'unavailable' }
    }
    return {
      status: 'answered',
      profiles: answer.profiles.map(profile => ({
        driverId: profile.driverId,
        linkedContactId: profile.linkedContactId,
        fullName: profile.fullName,
        parkName: profile.parkName,
        licence: profile.licence,
        dismissedAt: profile.dismissedAt,
      })),
      truncated: answer.truncated,
    }
  }
}

/** The production composition: both reads bound to their own context's public surface. */
export async function searchPeopleByExactLicenceV1(licence: unknown): Promise<ContactLicenceSearchResultV1> {
  return createContactLicenceSearchCompositionV1({
    resolveReadAuthority: resolveContactReadAuthorityV1,
    findDriverProfilesByExactLicence: findDriverProfilesByExactLicenceV1,
  })(licence)
}
