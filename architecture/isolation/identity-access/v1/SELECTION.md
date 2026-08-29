# CRM-ARCH-007 Identity Access slice selection

Identity Access is the first incremental isolation slice because it has the smallest controlled domain shape that still proves the complete migration template:

- one technical module (`users`);
- one owned data entity (`CrmUser`);
- zero foreign-write migration sites;
- zero provider relationships;
- zero owned credential names;
- an already-declared compatibility strategy preserving cookie/session behavior;
- an already-allowed Platform Shell dependency;
- a representative UI consumer with three exact legacy import sites.

Edge Delivery has fewer findings but no useful domain-write or cross-context contract flow to prove. AI Knowledge has only two caller findings but owns provider relationships and is a protected active domain. Work Management, Contacts and provider contexts have higher coupling and foreign-write debt. Identity Access therefore provides the lowest blast radius without reducing the milestone to folder-only refactoring.

The selected consumer is `gravity-mvp/src/components/layout/TopBar.tsx`. The slice does not change login policy, anonymous behavior, roles, cookies, user storage, user CRUD, provider access, database state or user-visible navigation. It establishes v1 contracts and an owner port, keeps the current `user-service.ts` behind a compatibility adapter, and migrates all TopBar Identity calls together so that consumer no longer has a split public/internal dependency.

Production deployment is not part of this source gate. The rollback is the exact base commit `99af9c696198c47089e1d6727580724d4df1e571`; the legacy implementation remains byte-identical and available behind the adapter.
