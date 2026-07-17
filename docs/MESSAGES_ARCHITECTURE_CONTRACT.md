# Messages Architecture Contract

## Provenance

The consolidated Messages development branch starts from:

- base commit: `8a95307d19a22a086794328496630962eae1b113`
- accepted parent: `25c8107198c1ff90e9c48bd8aa65eff7c53350dc`
- worktree: `/opt/codex-work/crm-messages-complete-clean`
- branch: `dev/messages-complete-consolidated`

Production is not a development source. This program must not deploy, restart
containers, mutate the production database, or run real provider writes.

## Canonical ownership

`Contact` is the CRM source of truth for one physical person. A MAX,
Telegram, WhatsApp, phone, chat, or call is evidence attached to a Contact,
not a replacement for it.

A `Driver` row is a park-specific DriverProfile. Its stable business key is:

```text
externalParkId + externalDriverProfileId
```

A Contact may own several profiles across the six supported parks and may
have more than one historical profile inside a park.

## Main profile

A manual operator choice wins. Without a manual choice, active profiles are
ranked in this order:

1. Наш Автопарк
2. YOKO
3. YOKO-2
4. YOKO-3
5. YOKO-4
6. YOKO.Доставка

Two active profiles in the same park are an anomaly. The system must surface
the anomaly and must not choose randomly. A sync error, timeout, or HTTP 429
does not mean dismissal and must not change the main profile.

## Phone ownership

All decisions use normalized E.164 values:

| Owners | Result | Automatic action |
| --- | --- | --- |
| 0 | `FREE` | The operator may add the phone |
| current Contact only | `SAME_CONTACT` | Reuse it; never duplicate |
| one other Contact | `OTHER_CONTACT` | Do not move it; open review |
| two or more Contacts | `AMBIGUOUS` | Block automatic attachment |

Names, activity, `lastOrderAt`, and similar heuristics never authorize an
automatic link or merge.

## Provider identities

Stable keys are:

- MAX: real provider user/message/route identity
- Telegram: `telegramUserId`
- WhatsApp: private JID
- DriverProfile: `externalParkId + externalDriverProfileId`

Telegram username and all provider display names are mutable attributes.
Different phone numbers across providers are valid. Group JIDs are never
treated as a person's phone.

## Universal ProfilePanel

Every private conversation and incoming call uses one canonical Contact
profile contract. The right panel must work for no-phone, no-profile,
provider-only, one-profile, and six-park Contacts. It presents saved business
data immediately and keeps raw provider enums and payloads inside collapsed
technical diagnostics.

The three-column product discipline remains:

- left: find the person or conversation
- center: communicate
- right: understand the person and choose an action

## Delivery identity

Messages are deduplicated by provider identity, real provider message ID, and
direction. Text, content, and time buckets are not deduplication keys.
Provider HTTP 200 is not proof of delivery; delivery requires a real provider
acknowledgement or echo.

## Change boundaries

AI Calls sources, deployment configuration, production environment, and
production data are protected. Provider transports may change only after a
reproduced defect and focused contract tests. Prisma changes require a
separate additive migration validated on an isolated database copy.
