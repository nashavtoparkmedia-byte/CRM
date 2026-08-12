import {
    MERGE_CONTACTS_COMMAND_V1,
    type MergeContactsResultV1,
} from '@/contracts/contacts/v1'
import { mergeContactsV1 } from '@/infrastructure/contact-merge-composition'

/**
 * Platform-owned composition of the existing cross-owner contact merge.
 * The route supplies only the two identities and a fixed audit actor; the
 * transaction and every owner write remain sealed inside the v1 capability.
 */
export function linkParkDriverToContactV1(
    contactId: string,
    driverId: string,
): Promise<MergeContactsResultV1> {
    return mergeContactsV1({
        contract: MERGE_CONTACTS_COMMAND_V1,
        operation: 'contact_to_driver',
        contactId,
        driverId,
        mergedBy: 'park_check',
    })
}
