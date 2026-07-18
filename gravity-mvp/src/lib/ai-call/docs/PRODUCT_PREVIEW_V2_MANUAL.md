# AI Calls Product Preview V2 — manual review

## Safety boundary

- Open only the direct DEV route `/ai-calls`.
- Use a dedicated local port and mocks. The preview does not call provider, SIP,
  FreeSWITCH, Contact APIs, or production services.
- Do not add the route to shared navigation and do not use production credentials.

## Review flow

1. Open `/ai-calls` and confirm the `DEV preview` and `Mock only` notices.
2. On **Проекты**, create a project, edit its name, change its type, stop/start it,
   and archive it. Confirm validation prevents an empty name.
3. On **Сценарий**, inspect all seven step types, edit the scenario metadata, and
   run validation. Confirm missing targets, unreachable steps, and cycles are
   explained without raw technical output.
4. On **Тестовый запуск**, enter a test phone and mock answers. Run the normal,
   transfer, and invalid-output cases. Confirm no real call or network request is
   made.
5. Inspect Contact resolution states: invalid, not found, matched, and ambiguous.
   Confirm ambiguous matching selects nobody and blocks a real launch.
6. On **Результат**, verify outcome, score, extracted fields, transcript, events,
   transfer summary, validation errors, and suggested manager action. Technical
   identifiers must remain inside the collapsed details section.
7. On **Настройки**, switch among configured, missing, invalid, and temporary
   provider states. Confirm the credential stays masked and diagnostics contain no
   secret.
8. Repeat the review at desktop width and at approximately 390 px width.

## Expected limitations

- Preview state is local to the browser session and is not persisted to PostgreSQL.
- Contact resolution uses a deterministic read-only mock registry.
- Provider checks are local simulations.
- Human handoff is a typed preview; live SIP transfer is not executed.
- Event idempotency protects application-level retries and parallel work inside one
  process. A database unique constraint remains a future coordinated migration.
- Shared navigation, Contact history, live telephony, and production deployment
  remain separate integration steps.
