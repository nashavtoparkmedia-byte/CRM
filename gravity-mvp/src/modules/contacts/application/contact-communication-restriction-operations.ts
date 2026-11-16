// The person card's «Ограничения связи» transport (Contact Identity V2, Q4; Security
// W4) reaches exactly these two Contacts operations and nothing else of the
// application layer. In particular it does not reach the card-for-conversation
// reader, which check-contact-card-read-model-boundary keeps to its allowlisted
// consumers; the policy mutation's one admitted adopter is pinned by
// check-contact-communication-policy-boundary.
export { readContactCommunicationRestrictionV1, setContactCommunicationPolicyV1 } from './contact-operations'
export type { ContactCommunicationRestrictionReadV1 } from './contact-operations'
