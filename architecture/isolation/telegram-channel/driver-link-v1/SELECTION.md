# CRM-ARCH-007 Telegram Driver Link selection

Selected complete 8/8 plan `migration_152c887cb9c50943`. Telegram Channel gains
atomic replace, unlink, patch and upsert commands through the existing acyclic
`platform_shell -> telegram_channel.public` dependency. All identity lookup,
vehicle/park transport decisions, security and HTTP orchestration remain caller-owned.
