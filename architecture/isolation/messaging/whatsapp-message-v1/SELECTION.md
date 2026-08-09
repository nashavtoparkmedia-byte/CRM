# CRM-ARCH-007 Messaging WhatsApp Message selection

Selected complete 8/8 plan `migration_904bb6b629b77b16`. Messaging gains
provider-message create and delivery-patch commands through the existing
acyclic `whatsapp_channel -> messaging.public` dependency. Dedup reads,
P2002 policy, media, workflows, events and transport remain caller-owned.
