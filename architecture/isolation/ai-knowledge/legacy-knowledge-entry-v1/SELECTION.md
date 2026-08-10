# CRM-ARCH-007R AI Knowledge legacy entry selection

Selected the first complete credential-free AI settings slice: all three legacy `KnowledgeBaseEntry` mutations move from Configuration's server action to strict AI Knowledge v1 owner commands. Authorization, identifier construction, caller response shape and success-only revalidation remain in the caller. The owner uses typed Prisma model operations; no raw SQL, provider transport, credential or runtime activation is introduced.
