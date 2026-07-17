# Messages Feature Inventory

Baseline: `8a95307d19a22a086794328496630962eae1b113`.

## Quality baseline

| Gate | Baseline result | Interpretation |
| --- | --- | --- |
| Vitest TypeScript suites | 263 passed, 3 DB tests skipped | Functional baseline is green |
| `npm test` | failed because 11 Node `test()` files were collected as empty Vitest suites | Test-discovery defect, not 11 failing behaviours |
| Node test runner | Separate runner was absent | Added by baseline test-harness commit |
| Project typecheck | 23 errors | Pre-existing debt; final requirement is zero delta |
| Production operations | none | DEV-only program |

## Functional matrix

| Function | Current implementation | Existing evidence | Known gap | Planned stage |
| --- | --- | --- | --- | --- |
| Contact resolution | `ContactResolutionService`, strict phone evidence, merge-chain resolution | 26 unit tests plus MAX shadow tests | Provider lifecycle is not exposed through one orchestration contract | Progressive enrichment |
| Phone ownership | `FREE`, `SAME_CONTACT`, `OTHER_CONTACT`, `AMBIGUOUS`, signed confirmation token | 21 unit tests, 6 UI tests | Provider-observed phone provenance is incomplete | Provider phone enrichment |
| DriverProfile | Park-specific `Driver` with composite unique key and six-park helpers | Multi-park and park identity suites | Global operator workflow is split across legacy routes | Driver search |
| Main profile | Manual selection and deterministic park priority | Multi-park tests | Anomaly and retry presentation must remain consistent in universal panel | ProfilePanel |
| Contact profile API | Typed payload with phones, identities, channels, profiles, suggestions, Telegram state, warnings | API and UI contract tests | Some drawer sections still derive state from chat/legacy driver data | Canonical API/ProfilePanel |
| Profile refresh | 15-minute TTL, park coalescing, Retry-After/backoff, cached-data preservation | 7 focused tests | Browser acceptance is missing | Browser harness |
| Search | Phone formats, names, canonical ranking, provider identities | 18 unit and 8 API tests | External profile search and grouped results are separate | Search contract |
| Local driver search | `/api/messages/drivers/search` searches local Driver rows | No focused route suite | Missing park grouping, external ID, conflict state, Contact creation | Driver search |
| Legacy driver search | `/api/drivers-search` calls one live Yandex connection | None | Violates local nightly-synced search contract | Driver search |
| Dispatcher links | Park and connection data exist | None | No canonical six-park link builder | Dispatcher links |
| Driver-first Contact | Manual profile attachment exists | Multi-park tests | No explicit idempotent create-from-profile action | Driver-first creation |
| Incoming calls | EslClient normalizes phone and creates timeline message | Existing calls code | Uses first-match phone lookup before resolution; ambiguous contract incomplete | Incoming calls |
| Contact merge | Transactional executor moves identities, phones, chats, tasks and archives source | Source implementation | No immutable preview hash, version guard, full graph manifest, or executable rollback | Safe merge |
| Provider-only routing | Chat has Contact and ContactIdentity; canonical merge chains exist | Contact resolution tests | Route canonicalization and anomaly diagnostics are incomplete | Provider routing |
| MAX inbound text | Canonical webhook requires real provider message identity for live text | Critical source tests | Encoding/recoverability report and isolated repair dry-run missing | MAX forensic |
| MAX outbound text | Provider external ID and retry paths exist | Stability source tests | Delivery/media/reply/reaction contract coverage is incomplete | MAX delivery |
| WhatsApp phone | Private JID path resolves Contact and backfills phone | Existing service code | Provenance/audit and LID/group negative cases need explicit tests | Provider enrichment |
| Telegram identity | Stable sender ID resolves Contact; username is stored as metadata/display | Existing action code | Shared-contact phone enrichment and canonical username history contract incomplete | Telegram identity |
| Telegram Bot | Contact profile API derives binding from `DriverTelegram` and DriverProfile | Profile API/UI code | Mutation workflow and conflict states are split across legacy bot-link API | Telegram Bot binding |
| Channel reachability | Unified row component and four-state operator labels | 4 row tests | Read/write route capability should be explicit in canonical payload | Reachability |
| Raw enum UX | Profile helpers translate several profile values | UI tests | Coverage is incomplete across API/provider errors | Operator UX |
| Client version | Next immutable assets are available | Build system | Canonical diagnostics marker and cache contract absent | Client versioning |
| Inline help | Existing drawer help and product guide | Source | Needs complete operator wording and links | Help/docs |
| Browser acceptance | Testing Library component coverage only | Component tests | No repository browser harness or scenario fixtures | Browser harness |

## Regression fixtures

The final isolated browser suite must include:

- Ремезов: phone suffix `9222155`, six parks, main YOKO
- Шабуров: name prefix `шабу`, one profile, main Наш Автопарк
- provider-only unresolved and redirected Contacts
- phone ownership states `FREE`, `SAME_CONTACT`, `OTHER_CONTACT`, `AMBIGUOUS`
- same-name Contacts and ambiguous phone ownership
- human Yandex warning with raw HTTP/provider data hidden

Production data is not used as writable test state. Fixtures and sanitized
payloads are the authoritative DEV acceptance inputs.
