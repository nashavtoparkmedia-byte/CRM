/**
 * Types for the AI-call bridge — manager-initiated outbound calls where
 * ChatGPT-driven voice agent talks to a lead, asks ~5 scenario questions,
 * handles objections, and transfers to a human via SIP REFER when stuck.
 *
 * Audio flow:
 *   FreeSWITCH (mod_audio_fork) ⇄ WebSocket ⇄ AudioBridge (this app)
 *           lead's voice → STT (Whisper) → text
 *                                              ↓
 *                                           LLM (gpt-4o-mini) → reply text
 *                                              ↓
 *                              TTS (Yandex SpeechKit) → audio → back to caller
 */

export type AiCallMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export type AiCallSessionStatus =
    | 'starting'      // FreeSWITCH originating the call, AI not yet engaged
    | 'greeting'      // AI playing the opening line
    | 'active'        // dialog in progress
    | 'transferring'  // SIP REFER in flight — connecting to manager
    | 'ended'         // hangup, normal completion
    | 'failed'        // technical failure (STT/LLM/TTS error or bridge dropped)

export interface AiCallSession {
    /** Maps 1:1 to Call.id in Prisma. */
    callId: string
    leadId: string
    managerId: string
    scenarioId: string
    status: AiCallSessionStatus
    /** Last-N transcript chunks kept in memory for prompt context. */
    transcript: AiCallTranscriptChunk[]
    /** When AI requested transfer (tool call), reason is stored here. */
    transferReason?: string
    startedAt: Date
    endedAt?: Date
}

export interface AiCallTranscriptChunk {
    role: AiCallMessageRole
    content: string
    /** ISO timestamp — when this chunk became finalized. */
    at: string
    /** STT confidence 0–1 (for user role only). */
    confidence?: number
    /** Tool call name when role=tool (e.g. 'transfer_to_manager'). */
    toolName?: string
    /** Tool call arguments when role=tool. */
    toolPayload?: Record<string, unknown>
}

/**
 * Scenario = system prompt + ordered questions. The LLM is told to follow
 * the questions but can branch on the lead's answers. Stored in Prisma as
 * AiCallScenario; runtime sees a flattened version here.
 */
export interface AiCallScenarioConfig {
    id: string
    name: string
    description?: string
    systemPrompt: string
    questions: AiCallScenarioQuestion[]
    /** Soft target call length in seconds — informs LLM about pacing. */
    targetDurationSec?: number
    /**
     * Canonical-key schema for the lead_data the LLM gathers via
     * save_lead_data (PR #57). When present, bridge constrains the
     * `field` arg in the save_lead_data tool to this list of keys, and
     * the CRM finalize mapper validates raw lead_data into typed
     * canonical fields. NULL/undefined = no schema; legacy passthrough.
     */
    outcomeSchema?: AiCallOutcomeSchema
    /**
     * Greeting A/B variants (PR #62). Array of `{ id, text, label? }`.
     * Bridge picks one via `hash(callUuid) % N` and speaks it directly
     * via TTS — no LLM round-trip on greeting. Variant ID lands in
     * the `greeting_started` event payload for funnel attribution.
     * NULL/undefined or empty array → legacy LLM-generated greeting.
     */
    greetingVariants?: AiCallGreetingVariant[]
}

/**
 * One greeting variant (PR #62). `id` is short and stable (e.g. 'A',
 * 'B', 'C') — used as the variant_id in events. `text` is the exact
 * phrase the bridge speaks. `label` is optional admin-facing UI
 * description; never emitted in payloads.
 */
export interface AiCallGreetingVariant {
    id: string
    text: string
    label?: string
}

/**
 * Outcome schema declared per scenario (PR #57). Defines the canonical
 * lead_data keys the LLM may emit via save_lead_data, with types and
 * required flags. Validation lives in src/lib/ai-call/scenario-schema.js
 * (pure CommonJS so node:test can load it without a TS loader).
 */
export interface AiCallOutcomeSchema {
    fields: AiCallOutcomeSchemaField[]
}

/**
 * One canonical lead_data field. `type` drives coercion + validation:
 *   - integer: parseInt; supports min / max bounds
 *   - boolean: native true/false OR Russian/English allowlist
 *              (да/нет/yes/no/true/false/есть/нету/1/0)
 *   - string:  non-empty after trim; optional maxLength truncation
 *   - enum:    case-insensitive match against `values`
 */
export type AiCallOutcomeSchemaField =
    | { key: string; type: 'integer'; required: boolean; min?: number; max?: number; label?: string }
    | { key: string; type: 'boolean'; required: boolean; label?: string }
    | { key: string; type: 'string';  required: boolean; maxLength?: number; label?: string }
    | { key: string; type: 'enum';    required: boolean; values: string[]; label?: string }

/**
 * Deterministic outcome enum mirrors the Prisma AiOutcome enum exactly.
 * See outcome-mapper.js for the decision tree.
 */
export type AiCallOutcomeValue =
    | 'qualified'
    | 'not_qualified'
    | 'unclear_engaged'
    | 'dropped_mid_call'
    | 'dropped_no_input'
    | 'error'

export interface AiCallScenarioQuestion {
    /** Free-text question the AI should naturally weave into the dialog. */
    text: string
    /** Optional keywords that mark the question as "answered" without follow-up. */
    intentKeywords?: string[]
    /** Optional branches: { intent: alternate-followup-question }. */
    branches?: Record<string, string>
}

/**
 * Messages exchanged over the AudioBridge WebSocket (FreeSWITCH ⇄ Node).
 * Inbound = from FS to us, outbound = us to FS.
 *
 * Audio frames are 16-bit PCM 8kHz mono (matching G.711 a-law decoded),
 * sent as binary WS messages. JSON control messages are sent as text.
 */
export type AudioForkInboundMessage =
    | { type: 'start'; callUuid: string; metadata: AudioForkMetadata }
    | { type: 'stop'; callUuid: string }
    | { type: 'dtmf'; callUuid: string; digit: string }

export type AudioForkOutboundMessage =
    | { type: 'play'; callUuid: string }       // signals upcoming TTS audio frames
    | { type: 'transfer'; callUuid: string; targetExtension: string; reason?: string }
    | { type: 'hangup'; callUuid: string; cause?: string }

/**
 * Decoded from the `fork_metadata` channel variable set in dialplan before
 * `audio_fork` is invoked. Tells the bridge which Call/lead this session ties to.
 */
export interface AudioForkMetadata {
    callId: string
    leadId: string
    scenarioId: string
    managerExtension: string  // where to transfer if needed
}

/**
 * Function-calling tools exposed to the LLM. The LLM decides when to invoke
 * them — most importantly transfer_to_manager when it can't answer.
 */
export interface AiCallTools {
    transfer_to_manager: {
        description: 'Transfer the live call to a human manager when the lead asks a question outside the AI scope or explicitly requests a human.'
        parameters: {
            reason: string  // free-text reason logged + shown to manager pre-pickup
        }
    }
    end_call: {
        description: 'End the call gracefully (after a goodbye line) when the scenario is complete or the lead refuses.'
        parameters: {
            outcome: 'completed' | 'refused' | 'no_interest'
            summary?: string
        }
    }
    save_lead_data: {
        description: 'Persist a structured field extracted from the dialog onto the lead record (e.g. driving experience years, preferred shift, city).'
        parameters: {
            field: string
            value: string | number | boolean
        }
    }
}
