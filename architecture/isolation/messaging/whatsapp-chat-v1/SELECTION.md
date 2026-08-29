# CRM-ARCH-007 Messaging WhatsApp Chat selection

Selected complete 7/7 plan `migration_038d96774ba66c22`. Messaging gains
channel-conversation upsert and locator-based patch commands through the existing
acyclic `whatsapp_channel -> messaging.public` dependency. Matching, P2002
recovery, Contacts, messages, media and transport remain caller-owned.
