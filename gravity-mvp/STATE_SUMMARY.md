# AI Knowledge Core — STATE_SUMMARY

Snapshot текущего состояния модуля на момент **safety checkpoint после PR6.1**.

- **Branch:** `feature/ai-knowledge-core`
- **Safety tag:** `ai-knowledge-core-pr6_1-stable`
- **Last commit:** PR6.1 visible Trusted Guard counters in extraction job
- **Smoke total:** 160/160 PASS

---

## Что реализовано

### PR1 — Foundation
- 5 моделей (`AiKnowledgeSection`, `AiKnowledgeItem`, `AiKnowledgeSource`, `AiExtractionJob`, `AiAgentConfig` extensions) + 5 enums
- Migration `20260520250000_add_ai_knowledge_core_foundation`
- 10 seed-секций (`tariffs`, `requirements`, `documents`, `deposit`, `schedule`, `payouts`, `faq`, `objections`, `promises`, `restrictions`)
- Read-only queries + server actions
- UI «Ядро знаний» вкладка (под-табы Ядро / Источники / Архив)

### PR2 — Extraction pipeline
- `pairBuilder.ts` — sampling клиент→менеджер пар в окне 60 мин
- `extractionPrompt.ts` — v2, whitelist 10 секций × 11 knowledge types
- `Extractor.ts` — main worker, Anthropic JSON-prefill / OpenAI JSON-mode
- Trigram-Jaccard dedup, numeric conflict detection, PII масккинг, verbatim evidence check
- Activation rule: `sourceCount ≥ 2 OR confidence ≥ 0.85 OR safety='requires_human'`
- UI: scope modal, tier selector (economy/balanced/quality), progress, auto-refresh

### PR2.5 — Governance
- Migration `20260520270000_add_knowledge_audit_log` + enum `AiKnowledgeAuditAction`
- `auditLog.ts` — tolerant write + before/after snapshots
- 8 actions: edit / archive / restore / verify / conflict resolve / supersede / manual create
- Pre-emptive поля `isVerified/verifiedBy/verifiedAt` (заведены ещё в PR1)
- UI: item card actions + edit drawer + verified badge + 4 модала (Edit / Conflict / Supersede / ManualCreate)

### PR3 — Retriever + Shadow / Runtime
- Migration `20260520280000_add_retrieval_policy_and_traces` (`AiRetrievalPolicy` + UsageLog/DecisionLog extensions)
- `Retriever.ts` — score = 0.4×title + 0.5×statement + 0.1×tags + 0.2 verified − 0.1 requires_human
- `applyPolicy` — 7 escalation reasons
- `Retriever.rerank.ts` + `retrievalPrompt.ts` — LLM rerank, tolerant null fallback
- `featureFlags.ts` — env-first source-of-truth (`AI_KNOWLEDGE_SHADOW_MODE`, `AI_KNOWLEDGE_RUNTIME_ENABLED`)
- Pipeline integration: `ContextBuilder`, `ResponseGenerator`, `PipelineWorker`
- UI: shadow traces + RuntimeModePill

### PR4 — Explainability
- `explainability.ts` — pure aggregator (Decision × Message × Usage × Item × Section × Source × AuditLog AFTER)
- `getDecisionExplainabilityForUi` — sources strip для не-Admin
- `previewDecisionRetry` — transient telemetry без persistence
- UI: модал «Почему AI так ответил?» — used items / filtered items с причинами / sources (admin) / audit-timeline / retry preview / advanced accordion

### PR5 — Production polish
- `readiness.ts` — counts + lastExtraction + activity7d + health7d + 5 checks + overall
- Operational readiness row + Runtime rollout modal (UX humanized после первой ревизии — без англицизмов / env-флаги скрыты в Технических деталях)
- `/settings/integrations/ai-knowledge-help` — 5+10 шагов (manager / admin)
- Inline microcopy + help-link weaving
- `legacyMigration.ts` — KnowledgeBaseEntry → AiKnowledgeItem с `source:legacy` tag, idempotent
- Legacy KB deprecation UI (collapsible, NOT deleted)
- Conflict UX polish (filter pills + superseded chains)
- Bulk verify + bulk archive drafts (Admin only, audit per-item)
- Explainability navigation polish (copy formulation)
- Health 7d summary row

### PR6 — Trusted Knowledge Guard
- `trustedGuard.ts` — pure module, defensive layer
- Trusted = active AND (isVerified OR `source:legacy` tag)
- При extraction: contradicts → forced draft + requires_human + tag `conflicts_with_trusted:<id>`
- Matches → tag `matches_trusted:<id>` + counter boost
- UI: red ⛔ «противоречит правилу» + green ✓ «подтверждает правило»

### PR6.1 — Visible counters
- В карточке extraction job: «X противоречит правилам — заблокировано» / «Y подтверждает проверенные правила»

### UX / infra fixes (после PR5)
- **autosave key on "Проверить"** (commit `6dfffb1`) — раньше click "Проверить" не сохранял apiKeyEncrypted
- **enum cast in saveAiConfig** (commit `ca70e19`) — раньше UPDATE падал с `42804 text → enum`, провайдер/ключ silently dropped. Исправлено через `$N::"AiProviderType"` cast.
- **UX humanization Runtime Readiness** (commit `d5ff2cf`) — убран Shadow/Runtime/Legacy жаргон, env-флаги в collapsible accordion

---

## Архитектурные red lines (все соблюдены)

- ❌ NO embeddings, NO pgvector
- ❌ NO fine-tune
- ❌ NO black-box LLM router
- ❌ NO archived/superseded в retrieval
- ❌ NO raw excerpts в generator prompts
- ❌ NO autonomous learning / feedback retraining
- ❌ NO vector dashboards / auto conflict merge
- ❌ NO runtime auto-enable (env-only)
- ✅ PII masked перед save
- ✅ Verbatim evidence check (anti-hallucination)
- ✅ Soft delete only для `AiKnowledgeItem`
- ✅ Channel-agnostic (`AiKnowledgeSourceOrigin.voice_transcript` ready)
- ✅ Shadow mode FIRST перед runtime flip
- ✅ Permission split server-side (sources Admin/Lead only)
- ✅ Trusted source guard (verified + legacy-migrated)

---

## Env flags (source of truth для runtime mode)

| Variable | Default | Что делает |
|---|---|---|
| `AI_KNOWLEDGE_SHADOW_MODE` | `0` | Включает наблюдение: retriever работает параллельно, ответ клиенту даёт legacy KB. Trace пишется в `AiDecisionLog.shadowRetrievalSummary`. |
| `AI_KNOWLEDGE_RUNTIME_ENABLED` | `0` | Переводит AI на ответы из ядра. Включается **только** после shadow-наблюдения и при зелёном readiness checklist. |

Установка обоих в `0` = legacy режим (старая KB, ядро не подключено).
Только shadow = `1, 0`.
Runtime = `1, 1` (рекомендуется держать shadow=1 для compare).

UI **никогда** не флипает env. RuntimeRolloutModal показывает текущие значения в «Технические детали» accordion.

---

## Текущий статус rollout

**Mode:** Legacy (по умолчанию). Knowledge Core собран архитектурно и engineered, но ещё **не наблюдает** трафик чатов.

**Что нужно перед shadow:**
- Настроен AI Провайдер (apiKey сохранён → проверяется debug-скриптом `node scripts/debug_ai_config.js`)
- Импортированы переписки (вкладка «Синхронизация»)
- Запущен «Собрать ядро» хотя бы раз (вкладка «Ядро знаний»)
- В readiness pill «Готов» / «Нужна доводка» (не «Не готов»)

**Что нужно перед runtime:**
- Shadow собрал ≥ 20 наблюдений за 7 дней (`shadow_activity` check)
- Verified покрытие ≥ 60% (`verified_coverage` check)
- Нет неразрешённых спорных знаний (`conflicts` check)
- Сбор не старше 3 дней (`extraction_recency` check)
- Эскалация ≤ 40% за 7 дней (`escalation_rate` check)
- Trusted Guard counters в норме (не сотни blocked-by-trusted)

---

## После перезапуска ноутбука / dev-сервера

1. **Поднять local infra**:
   ```
   node gravity-mvp/scripts/ensure_local_infra.js
   ```

2. **Запустить базовую ступень** (см. CLAUDE.md):
   - CRM: `cd gravity-mvp && npm run dev`
   - Scraper API: `cd yandex-fleet-scraper && npm run start:api`
   - Scraper Worker: `cd yandex-fleet-scraper && npm run start:worker`
   - MAX Scraper: `cd max-web-scraper && node index.js`

3. **Если работа над AI Knowledge Core возобновляется** — `git checkout feature/ai-knowledge-core` уже активен. Не делать `git pull origin main --ff-only` (был инцидент потери PR1-PR5).

4. **Откат всего AI Knowledge Core до состояния до PR1** (на случай катастрофы):
   ```
   node gravity-mvp/scripts/rollback_knowledge_core.js
   ```
   Это DROP'ает таблицы Knowledge Core + удаляет migrations из `_prisma_migrations`. Идемпотентно.

---

## Smoke regression (база для verification)

```
smoke_knowledge_pr1.js          13/13 ✅
smoke_pii_check.js              16/16 ✅
smoke_extraction_pr2.js         10/10 ✅
smoke_governance_pr2_5.js       12/12 ✅
smoke_retrieval_pr3.js          19/19 ✅
smoke_explainability_pr4.js     12/12 ✅
smoke_readiness_pr5.js          12/12 ✅
smoke_legacy_migration_pr5.js   21/21 ✅
smoke_production_polish_pr5.js  20/20 ✅
smoke_trusted_guard_pr6.js      25/25 ✅
─────────────────────────────────────────
Total:                         160/160 ✅
```

Запуск всех: из `gravity-mvp/` → `node scripts/<имя>.js`.

---

## Next step

**Phase: rollout / stabilization** (не новая разработка).

1. Включить shadow mode на проде (`AI_KNOWLEDGE_SHADOW_MODE=1`)
2. Запустить «Собрать ядро» с реальными переписками
3. Через 3–7 дней — посмотреть readiness checklist + health 7d
4. Подтверждать ключевые правила вручную через UI (тарифы, требования, документы)
5. Разрешать спорные знания если появятся
6. Когда checklist «Готов» — включить runtime через env + перезапуск CRM
7. Мониторить через explainability модал реальные ответы AI

**Future work** (после стабилизации, не сейчас):
- embeddings
- AI-call reuse (voice channel — архитектурно готов)
- cross-channel memory
- temporal retrieval
- feedback tuning

---

## Files inventory

### Library (`gravity-mvp/src/lib/ai/knowledge/`)
- `auditLog.ts` · `Extractor.ts` · `Retriever.ts` · `Retriever.rerank.ts`
- `explainability.ts` · `extractionPrompt.ts` · `featureFlags.ts`
- `legacyMigration.ts` · `pairBuilder.ts` · `queries.ts` · `readiness.ts`
- `retrievalPrompt.ts` · `textUtils.ts` · `trustedGuard.ts`

### Migrations (`gravity-mvp/prisma/migrations/`)
- `20260520250000_add_ai_knowledge_core_foundation/`
- `20260520260000_add_extraction_snapshot_fields/`
- `20260520270000_add_knowledge_audit_log/`
- `20260520280000_add_retrieval_policy_and_traces/`

### Scripts (`gravity-mvp/scripts/`)
- 10 smoke scripts (см. таблицу выше)
- `seed_knowledge_sections.js` — idempotent seed 10 секций
- `rollback_knowledge_core.js` — DROP всех Knowledge Core таблиц + migrations
- `debug_ai_config.js` — read-only диагностика AiAgentConfig state

### UI (`gravity-mvp/src/app/settings/`)
- `ai/page.tsx` + `ai/AiControlCenterClient.tsx` + `ai/actions.ts`
- `integrations/ai-knowledge-help/` (page.tsx + AiKnowledgeHelpClient.tsx)
- `integrations/ai-call-help/page.tsx` (hub-карта обновлена)

---

## Recovery contract

| Что | Команда |
|---|---|
| Branch | `git checkout feature/ai-knowledge-core` |
| Safety tag | `git checkout ai-knowledge-core-pr6_1-stable` |
| Remote origin | `https://github.com/nashavtoparkmedia-byte/CRM` |
| Откат БД | `node gravity-mvp/scripts/rollback_knowledge_core.js` |
| Применить migrations | `cd gravity-mvp && npx prisma migrate deploy` |
| Re-seed sections | `cd gravity-mvp && node scripts/seed_knowledge_sections.js` |
| Полный sanity | прогон 10 smoke выше |
