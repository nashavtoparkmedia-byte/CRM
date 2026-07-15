# CRM Messages Product Guide

Version: multi-park-dev-rc
Date: 2026-07-13
Baseline commit: 30b713826a48afceb60351dca47de578d6056b26
Release image: not built for production
Last updated: 2026-07-13

## Core Model

Contact is the CRM person. Chat, Message, ContactIdentity, and ContactPhone describe communication around that person. MAX, Telegram, and WhatsApp identities are provider reachability and channel identities, not the CRM source of truth.

## Contact Resolution

Automatic linking uses strict evidence only. Phone may link data only when active phone ownership is unique. Name, activity, lastOrderAt, and random selection are not identity proof. Ambiguous ownership is surfaced and must not create automatic links.

## DriverProfile

A Driver row represents a concrete Yandex driver profile. Multi-park semantics add Contact to many Driver profiles through Driver.contactId and Contact.mainDriverId. Existing Contact.yandexDriverId stays for backward compatibility.

Approved park order:
1. Наш Автопарк
2. YOKO
3. YOKO-2
4. YOKO-3
5. YOKO-4
6. YOKO.Доставка

A person can have several profiles across parks and several historical profiles inside one park. Historical profiles are preserved and not selected as main.

## Active, Dismissed, Main

Working profiles can become main. Dismissed profiles are history and have no  make main action. If a park has 2+ working profiles for one Contact, it is a data anomaly; CRM shows the warning and excludes that park from automatic main-profile choice.

Main profile priority:
1. valid manual active main;
2. park priority above;
3. no active profiles means Contact.mainDriverId is null.

## Phone And Status Changes

Phone changes update the same DriverProfile. Old phones remain historical and are not fresh auto-match evidence. Status changes preserve old profiles and may trigger a new main profile by the same park, then by park priority.

## Yandex Sync

Driver profile sync and trips sync must process every ApiConnection, not the last connection. Each profile stores lastExternalPark from ApiConnection.name or parkId. If one park fails, other parks continue and parkResults report the partial failure.

Nightly sync is represented by /api/cron/sync-trips and should be scheduled for 03:00 Asia/Yekaterinburg outside the app runtime. Runtime overlap protection is provided by SyncStatus/OperationalJobs contracts.

## Card Open Refresh

Opening a Contact shows stored data immediately, then POSTs /api/contacts/:id/driver-profiles/refresh. The refresh recalculates main profile and returns anomalies without blocking the UI. On error, old data remains visible.

## Manual Binding

Manual DriverProfile binding must confirm conflict state before moving a profile linked to another Contact. ФИО may be a display filter only, not proof.

## Merge

Contact merge is separate from DriverProfile binding. Read-only planners or diagnostics must not be described as completed auto-merge. If auto-merge is not implemented, operators must resolve manually.

## Right Panel States

The /messages right panel must not show fake Парк: Яндекс or Роль: Водитель without a real DriverProfile. It shows no raw provider id as the main title, shows sync state, main profile, profiles by park, dismissed profiles collapsed, anomalies, manual actions, and technical data.

## Troubleshooting

If a Contact has no DriverProfile, check phone ownership first. If there are two owners of one phone, do not link automatically. If a park has two working profiles, show both and request data review. If sync fails for one park, keep existing data and retry that park.

## What Is A Bug

A bug includes linking by name, selecting a random driver, hiding active-profile anomaly, showing historical phone as primary, processing only one Yandex connection, or displaying fake park/role data.

## Operator Actions

Operators can write through channels, inspect identities, review anomalies, manually choose a main active profile, and manually bind a DriverProfile after conflict confirmation.

## Acceptance Checklist

- all six parks are processed;
- several profiles of one Contact are not ambiguous;
- two active profiles in one park are an anomaly;
- dismissed profiles are preserved and collapsed;
- main profile selection is deterministic;
- card-open refresh is visible;
- no fake park/role is shown;
- Contact Resolution safety tests pass.

Project rule: any Messages change must update code, tests, inline help, and this guide.

## Multi-Park Driver Profiles RC

Version: multi-park final dev RC
Date: 2026-07-13
Commits included: stable park identity, manual-safe cross-park person resolution, final integration.

### Lifecycle

MAX, Telegram and WhatsApp messages enter CRM as channel events. CRM creates or reuses:

1. Contact: the CRM person and source of truth.
2. ContactIdentity: provider identity such as MAX, Telegram, or WhatsApp.
3. Chat: conversation inside the channel.
4. Message: inbound/outbound message history.
5. Phone resolution: normalized active ContactPhone when the channel provides a phone.
6. Suggested DriverProfile: Yandex park profiles found by phone/name as candidates only.
7. Manual/proven attachment: manager confirms profiles, or a future stable externalPersonKey proves them.
8. Main DriverProfile: active attached profile selected manually or by park priority.
9. Synchronization: nightly full sync and card-open refresh keep park profiles current.
10. Merge/manual review: Contact merge is separate from DriverProfile attachment.

### Normal Behavior

- One Contact may have many DriverProfiles across six parks.
- Several active profiles in different parks is normal.
- One active and several dismissed profiles in one park is normal.
- Two or more active profiles in the same park for one Contact is an anomaly.
- Phone and FIO are candidate signals only; they are not automatic person proof.
- Suggested profiles must be reviewed by a manager before attachment.

### Bug Signals

- A phone-only match attaches profiles automatically.
- A provider display id becomes the main Contact title when better data exists.
- A DriverProfile already linked to another Contact is silently moved.
- A dismissed profile becomes main automatically.
- Contact merge moves chats/messages without explicit merge review.

### Operator Actions

- Review suggested profiles in the right panel.
- Select only profiles that belong to the same person.
- Use "Привязать выбранные" for DriverProfile attachment.
- Use Contact merge only when duplicate CRM Contacts must be merged.
- Use "Сделать главным" only for active attached profiles.

### Troubleshooting

- If refresh fails, old data remains visible; retry by reopening the card or refreshing the page.
- If a profile belongs to another Contact, open that Contact or review merge; do not force attach.
- If profiles are suggested but not attached, this is expected until manager confirmation.

## Contact Profile Final UX

- The main DriverProfile is always visible.
- The full attached-profile list is collapsed by default and remembers the operator's local preference per Contact.
- Expanding the profile list does not change Contact data and is preserved during background refresh.
- Dismissed profiles have a second independent collapsed level inside each park.
- Changing the main profile requires an explicit CRM confirmation dialog; cancel and Escape do not write data.
- The right-panel channel badge counts unique providers, so MAX + Telegram + WhatsApp is shown as `3 канала`.
- Contact source is labelled explicitly as `Источник: ...`; it is not a park or DriverProfile badge.
