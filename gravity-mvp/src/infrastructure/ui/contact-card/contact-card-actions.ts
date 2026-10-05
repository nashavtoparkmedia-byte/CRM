'use server'

// M3A2 Contact Card composition: the platform_shell server seam that turns the
// Messaging host's persisted Chat.id into the one Contact card it may show.
//
// Messaging alone answers which Contact a conversation belongs to (RCQ1,
// messaging.ResolveConversationContactQuery.v1), and Contacts alone owns the
// card core (ContactCardSummary.v1). This action composes those two public
// operations and nothing else:
//   - the exact Chat.id is the only input, and it reaches RCQ1 unchanged;
//   - only a `resolved` answer reads the summary, for exactly the canonical
//     contactId RCQ1 returned;
//   - `unresolved`, `ambiguous` and `not_found` pass through and read nothing;
//   - a resolved Contact the summary cannot find, and any failure of either read
//     (a broken merge lineage included), fail closed.
// No other conversation, phone, provider identity, display name or lookup is
// ever consulted, and nothing is written.

import { RESOLVE_CONVERSATION_CONTACT_QUERY_V1 } from '@/contracts/messaging/v1'
import { getContactCardSummaryV1, type ContactCardSummaryV1 } from '@/modules/contacts/public/v1'
import { resolveConversationContactV1 } from '@/modules/messaging/public/v1'

/** What the Contact card may show for one conversation. Provider-neutral. */
export type ContactCardLoadResultV1 =
  | { status: 'resolved'; summary: ContactCardSummaryV1 }
  | { status: 'unresolved' }
  | { status: 'ambiguous' }
  | { status: 'not_found' }
  | { status: 'contact_not_found' }
  | { status: 'failed' }

export async function loadContactCardForConversationV1(chatId: string): Promise<ContactCardLoadResultV1> {
  try {
    const resolution = await resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId })
    if (resolution.status !== 'resolved') return { status: resolution.status }
    const summary = await getContactCardSummaryV1(resolution.contactId)
    // RCQ1 named this Contact, so a missing summary is an inconsistency to show,
    // never a reason to look for another Contact.
    return summary === null ? { status: 'contact_not_found' } : { status: 'resolved', summary }
  } catch (err: unknown) {
    // The cause is logged, never returned: it is not operator text.
    console.error('[contact-card] load failed:', err instanceof Error ? err.message : err)
    return { status: 'failed' }
  }
}
