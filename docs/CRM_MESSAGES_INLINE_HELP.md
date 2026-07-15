# CRM Messages Inline Help

This text is mirrored in the `/messages` right panel help modal.

- MAX, Telegram and WhatsApp create Contact, Identity, Chat and Message records.
- Contact is the CRM person.
- DriverProfile is a park-specific Yandex profile.
- Phone and FIO are suggestions only; they do not attach cross-park profiles automatically.
- Suggested profiles require manager confirmation.
- DriverProfile attachment and Contact merge are different operations.
- Main profile is selected only from attached active profiles.
- Nightly sync and card-open refresh update saved profiles without blocking the UI.
- Ambiguous ownership blocks automatic attachment and requires manual review.
- The main DriverProfile remains visible while the complete park list can be expanded when needed.
- The profile-list expansion is a local UI preference and does not change Contact data.
- `Сделать главным` opens a separate confirmation dialog with profile details before any request is sent.
- Channel totals count unique providers; duplicate identities do not increase the number.
- `Источник: Яндекс` describes Contact origin only and never identifies a park.
