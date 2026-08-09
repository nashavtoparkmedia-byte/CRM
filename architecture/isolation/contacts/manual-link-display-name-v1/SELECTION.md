# CRM-ARCH-007 Contacts manual-link name selection

Selected `migration_30341c5551662f55`, the complete one-site Messaging write
to Contacts-owned `Contact.displayName`. Messaging already has a reviewed
`contacts.public` dependency, so this slice needs no new graph edge. It adds
one explicit command for the manual-link policy, which differs from the
placeholder-only v1 and channel-authority v2 resolution policies.

The neighboring Chat/Driver reads and Chat update, phone-identity ContactService
flow, revalidation, error translation and production runtime remain out of
scope and byte-structurally guarded.
