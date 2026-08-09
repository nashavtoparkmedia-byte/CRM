# CRM-ARCH-007 Messaging Telegram history-import-jobs selection

Selected complete 3/3 plan `migration_3b4198ada8c5ffad`. The established
Messaging job contract family gains provider-neutral channel cleanup while
Telegram reuses the existing connection cleanup and partial patch commands.
Telegram already depends on Messaging public; provider orchestration and
nonblocking catches remain local. No cleanup or import ran.
