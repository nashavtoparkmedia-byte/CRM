-- Structured Outcome Layer (PR #57)
--
-- Adds four columns on Call to lift AI-call qualification out of the
-- opaque `aiAnalysis Json` blob into typed, queryable, business-layer
-- fields. Also adds an `outcomeSchema` column on AiCallScenario so each
-- scenario can declare a canonical-key schema for the lead_data the
-- LLM gathers via save_lead_data().
--
-- Migration is idempotent via DO-block for the enum type and
-- IF NOT EXISTS on ALTER TABLE — safe on greenfield DBs and on dev
-- boxes that already have these columns from manual experimentation.
-- Pattern mirrors 20260520210100_add_temporary_contact_phones.

-- ── AiOutcome enum ────────────────────────────────────────────────
-- Exactly the 6 architect-defined values. Insertion order matters:
-- this is the canonical ordering used by analytics ORDER BY clauses.
DO $$ BEGIN
    CREATE TYPE "AiOutcome" AS ENUM (
        'qualified',
        'not_qualified',
        'unclear_engaged',
        'dropped_mid_call',
        'dropped_no_input',
        'error'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── Call columns ──────────────────────────────────────────────────
-- aiOutcome           — typed enum, queryable by Prisma.
-- aiOutcomeReason     — short snake_case slug (NOT a summary).
--                       Examples: 'llm_qualified', 'user_hangup_mid_call',
--                                 'llm_transferred_to_manager'.
--                       Appended with ';validation_issues=N' when the
--                       LLM's lead_data didn't conform to scenario schema.
-- qualificationScore  — 0–100 integer from LLM (end_call tool arg).
-- leadDataStructured  — canonical-keyed typed lead data after validation.
--                       Raw aiAnalysis stays in `aiAnalysis Json?` for
--                       forensics; business queries hit this column.
ALTER TABLE "Call"
    ADD COLUMN IF NOT EXISTS "aiOutcome"           "AiOutcome",
    ADD COLUMN IF NOT EXISTS "aiOutcomeReason"     TEXT,
    ADD COLUMN IF NOT EXISTS "qualificationScore"  INTEGER,
    ADD COLUMN IF NOT EXISTS "leadDataStructured"  JSONB;

-- Index for funnel queries: "WHERE aiOutcome = 'qualified' AND startedAt
-- > now() - interval '7 days'". Bounded scan even at high call volume.
CREATE INDEX IF NOT EXISTS "Call_aiOutcome_startedAt_idx"
    ON "Call"("aiOutcome", "startedAt" DESC);

-- ── AiCallScenario column ─────────────────────────────────────────
-- outcomeSchema JSON shape (validated in code, not at DB level — keeps
-- the migration tiny):
--   {
--     "fields": [
--       { "key": "hasLicenseB",     "type": "boolean", "required": true },
--       { "key": "experienceYears", "type": "integer", "required": false,
--                                    "min": 0, "max": 50 },
--       { "key": "city",            "type": "string",  "required": false },
--       { "key": "shiftPreference", "type": "enum",    "required": true,
--                                    "values": ["day","night","rotating","any"] }
--     ]
--   }
--
-- NULL = scenario has no schema; mapper passes lead_data through verbatim.
ALTER TABLE "AiCallScenario"
    ADD COLUMN IF NOT EXISTS "outcomeSchema" JSONB;
