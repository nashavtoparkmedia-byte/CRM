# AI Knowledge Core — STATE_SUMMARY

Snapshot текущего состояния модуля на момент **safety checkpoint после PR7.12.2**.

- **Branch:** `feature/ai-knowledge-core`
- **Latest safety tag:** `ai-knowledge-core-pr7-12-stable` (этот snapshot)
- **Предыдущий safety tag:** `ai-knowledge-core-pr7-complete` (после PR7.11)
- **Last commit:** `e7a5582` chore(deps): sync package-lock
- **Last feature commit:** `eb4ae92` PR7.12.2 provenance UX deepening
- **Smoke total:** 195/195 PASS (11 suites)

---

## Что система умеет теперь

| Возможность | PR / commit |
|---|---|
| Automatic knowledge extraction из переписок (WhatsApp / Telegram / MAX) | PR2 |
| Verbatim evidence check (anti-hallucination) | PR2.2 |
| Trigram-Jaccard dedup без embeddings | PR2 |
| Numeric conflict detection (тарифы/проценты/сроки) | PR2 |
| PII масскинг (телефоны, email, ВУ номера) | PR2.2 |
| Governance: edit / archive / restore / verify / supersede / conflict resolve | PR2.5 |
| Audit-trail с before/after snapshots | PR2.5 |
| Retrieval с shadow/runtime режимами + LLM rerank | PR3 |
| Source-of-truth для shadow/runtime: env vars (deployment-only) | PR3.4 |
| Explainability модал «Почему AI так ответил?» | PR4 |
| Retry preview с transient telemetry | PR4 |
| Filtered usages — «что AI сознательно не использовал» | PR4 |
| Operational readiness checklist + health 7d | PR5.1, PR5.10 |
| Runtime rollout modal (env-controlled, не флипает) | PR5.2 |
| Help система `/ai-knowledge-help` (manager + admin) | PR5.3 |
| Inline microcopy + help-link weaving | PR5.4 |
| Legacy KB → Core migration (idempotent) | PR5.5 |
| Legacy KB UI deprecation (collapsible, не удалена) | PR5.6 |
| Bulk verify + bulk archive drafts | PR5.8 |
| Trusted Knowledge Guard — блокировка противоречий verified | PR6 |
| Source provenance (per-connection для WhatsApp) | PR7.1, PR7.6.5 |
| Source-aware extraction (selector в модале) | PR7.3, PR7.4 |
| Honest sync stamps (без «Актуально») | PR7.5 |
| Job-card connection info + live status | PR7.6 |
| disableKnowledgeSource по аккаунту | PR7.7 |
| resetKnowledgeCore — 3 mode (auto_only / unverified / full) | PR7.8 |
| Источники panel с list connections + disable button | PR7.9 |
| Reset modal: NO default, typed confirm для full | PR7.9 |
| Rebuild flow: post-reset CTA + context summary + safety warnings | PR7.10 |
| Header card «Источники памяти AI» в Источники sub-tab | PR7.12 |
| Sync card last-import account info + multi-account summary | PR7.12, PR7.12.2 |
| Sync per-job fallback «источник аккаунта неизвестен» | PR7.12.2 |
| Item-card compact source badges «Откуда взято: …» | PR7.12.2 |
| Selector: «есть история» / «истории нет» hint per row | PR7.12 |
| Selector: TG/MAX явное «точечный выбор аккаунта пока в работе» | PR7.12.2 |
| Rebuild CTA: «Будет участвовать» + «Не участвуют» preview | PR7.12, PR7.12.2 |
| Terminology cleanup (scope/legacy/shadow/safety-фильтр → human) | PR7.12.2 |

## Что НЕ поддерживается (намеренно или ограничения схемы)

| Не поддерживается | Причина |
|---|---|
| TG/MAX account-level provenance | Schema не хранит chat ↔ connection link; будет PR8 |
| Embeddings / pgvector | Архитектурное red line — only BM25/trigram-Jaccard |
| Fine-tune модели | Архитектурное red line — only prompt + LLM |
| Autonomous learning / feedback retraining | Архитектурное red line |
| Auto conflict resolution / auto-merge | Архитектурное red line — admin decides |
| Voice channel ingestion | Schema ready (`voice_transcript` origin), pipeline не подключён |
| Temporal retrieval (recency boost) | Out of MVP |
| Cross-channel memory | Out of MVP |
| Physical delete для AiKnowledgeItem | Намеренно — soft delete only для explainability/audit |
| Runtime auto-enable | Env-only, UI не флипает (защита от случайного rollout) |

---

## Архитектурные red lines (все соблюдены)

- ❌ NO embeddings, NO pgvector
- ❌ NO fine-tune
- ❌ NO black-box LLM router
- ❌ NO archived/superseded в retrieval results
- ❌ NO raw excerpts в generator prompts
- ❌ NO autonomous learning / feedback retraining
- ❌ NO vector dashboards / auto conflict merge
- ❌ NO runtime auto-enable (env-only)
- ❌ NO physical delete для AiKnowledgeItem (soft archive only)
- ❌ NO one-click destructive actions (typed confirm для full reset)
- ❌ NO fake provenance attribution (TG/MAX honestly NULL до PR8)
- ✅ PII masked перед save
- ✅ Verbatim evidence check (anti-hallucination)
- ✅ Channel-agnostic (`AiKnowledgeSourceOrigin.voice_transcript` ready)
- ✅ Shadow mode FIRST перед runtime flip
- ✅ Permission split server-side (sources Admin/Lead only)
- ✅ Trusted source guard (verified + legacy-migrated)
- ✅ Source-aware provenance + soft-disable

---

## Env flags (source of truth для runtime mode)

| Variable | Default | Что делает |
|---|---|---|
| `AI_KNOWLEDGE_SHADOW_MODE` | `0` | Shadow: новое ядро работает в фоне, ответ клиенту даёт legacy KB. Trace в `AiDecisionLog.shadowRetrievalSummary`. |
| `AI_KNOWLEDGE_RUNTIME_ENABLED` | `0` | Runtime: AI отвечает из ядра. Включается **только** после shadow-наблюдения и при зелёном readiness checklist. |

UI **никогда** не флипает env. RuntimeRolloutModal показывает текущие значения в «Технические детали» accordion и checklist готовности.

---

## Текущий статус rollout

**Mode:** Legacy (по умолчанию). Knowledge Core собран архитектурно, не наблюдает трафик.

**Готовность к shadow:**
- AI Провайдер настроен (apiKey в БД, см. `scripts/debug_ai_config.js`)
- Импортированы переписки (Синхронизация)
- Запущен «Собрать ядро» хотя бы раз
- Readiness pill «Готов» или «Нужна доводка»

**Готовность к runtime:**
- Shadow собрал ≥ 20 наблюдений за 7 дней
- Verified покрытие ≥ 60%
- Нет неразрешённых спорных знаний
- Сбор не старше 3 дней
- Эскалация ≤ 40% за 7 дней

---

## Smoke regression (baseline 195/195)

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
smoke_source_control_pr7.js     35/35 ✅
─────────────────────────────────────────
Total:                         195/195 ✅
```

Запуск всех: из `gravity-mvp/` → `node scripts/<имя>.js`.

---

## Migrations (текущее на dev DB)

```
20260520210000_add_cancelled_callstatus           (main)
20260520213000_add_ai_outcome_layer               (main)
20260520220000_add_ai_call_event                  (main)
20260520223000_add_stt_suspicious_pattern_event   (main)
20260520230000_add_recovery_attempted_event       (main)
20260520233000_add_scenario_greeting_variants     (main)
20260520240000_add_scenario_prompt_fragments      (main)
20260520250000_add_ai_knowledge_core_foundation   (my PR1)
20260520260000_add_extraction_snapshot_fields     (my PR2.1)
20260520270000_add_knowledge_audit_log            (my PR2.5)
20260520280000_add_retrieval_policy_and_traces    (my PR3.1)
20260522000000_add_source_provenance_and_disable  (my PR7.1)
```

Все applied. Backfill `scripts/backfill_source_connection_pr7.js` запущен на dev (27/27 WA sources resolved).

---

## Next phase

**Pause / stabilization** (по решению пользователя). Без новых больших PR сразу.

Возможные направления (future, не сейчас):
- **PR8**: chat-level provenance для Telegram/MAX (schema migration + ingestion update)
- **Shadow rollout**: включить `AI_KNOWLEDGE_SHADOW_MODE=1` на проде, собрать первые 7 дней наблюдений
- **Verified coverage growth**: подтверждать ключевые правила вручную
- **Voice ingestion**: подключить AI-call transcripts в extraction pipeline
- **Production monitoring**: внешний health-check + retrieval analytics

---

## Recovery contract

| Что | Команда |
|---|---|
| Branch | `git checkout feature/ai-knowledge-core` |
| Latest safety tag | `git checkout ai-knowledge-core-pr7-12-stable` |
| Previous safety tag | `git checkout ai-knowledge-core-pr7-complete` |
| Старая safety tag | `git checkout ai-knowledge-core-pr6_1-stable` |
| Pre-merge snapshot | `git checkout pre-telephony-merge-rev2` |
| Post-merge stable | `git checkout post-telephony-merge` |
| Remote origin | `https://github.com/nashavtoparkmedia-byte/CRM` |
| Откат БД до состояния pre-PR1 | Исторический destructive rollback permanently disabled; use reviewed current migrations/recovery procedures. |
| Применить migrations | `cd gravity-mvp && npx prisma migrate deploy` |
| Re-seed sections | `cd gravity-mvp && node scripts/seed_knowledge_sections.js` |
| Re-backfill WA provenance | `node gravity-mvp/scripts/backfill_source_connection_pr7.js` |
| Полный sanity | прогон 11 smoke выше |
| Debug AiAgentConfig state | `node gravity-mvp/scripts/debug_ai_config.js` |
