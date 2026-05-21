# STT Garbage Patterns — Production Research

**Companion to:** [`docs/design/conversation-intelligence-layer.md`](../design/conversation-intelligence-layer.md) — the `stt_suspicious_pattern` event type.

**Status:** observational research note. No code changes. Catalog feeds two future PRs:
1. The `stt_suspicious_pattern` matcher inside the Conversation Intelligence Layer implementation.
2. A separate future "STT garbage filter" PR that drops corrupted STT finals before they reach the LLM.

---

## 1. Why this exists

The 49-call production sample analyzed during the Product Intelligence assessment exposed Yandex STT consistently producing **structured garbage** during silence or low-quality audio frames. The bot's LLM dialog code (`call-session.js`) accepts whatever STT returns as a genuine lead utterance, then attempts to respond — corrupting the dialog state and producing `unclear` outcomes that look like lead-driven ambiguity but are actually transport-layer hallucinations.

This doc catalogs the patterns. Each has been observed in production, has a candidate detection rule, and ships with a false-positive assessment so future filtering does not silence real leads.

---

## 2. Failure surface

Common to all patterns below:

- **Source:** Yandex SpeechKit STT, in production deployment as of PR #53.
- **Trigger conditions:** silence frames, low-volume audio, echo of bot's own TTS bleeding through `mod_audio_fork` in mono mix-type, or simply STT being asked to transcribe sub-second utterances.
- **Downstream effect:** the bot's `_onSttFinal` handler at `tools/audio-bridge-day1/call-session.js:231` accepts the text, debounces with `USER_PAUSE_MS`, sends to LLM as a "user said" message, LLM responds based on garbage — call dynamics derail.
- **Visibility today:** zero. The only signal is reading the raw `Call.transcript` after the fact. The proposed `stt_suspicious_pattern` event makes this visible per-call.

---

## 3. Pattern catalog

### 3.1 `subtitle_credits`

**The dominant production hallucination.** Appears in multiple `unclear` calls in the assessment sample. Yandex STT, when fed silence or very-low-signal audio, falls back to outputting a Russian-subtitle-credit template — apparently a residue of its training corpus (Russian-subtitled video content).

**Observed phrases (real, redacted to the consistent template):**

```
Редактор субтитров А.Синецкая Корректор А.Егорова
Редактор субтитров А.Семкин Корректор А.Егорова
```

The "Корректор А.Егорова" tail is consistent across observations. The "Редактор субтитров А.[Lastname]" stub varies the surname (А.Синецкая, А.Семкин observed; likely more variants in larger samples).

**Why dangerous:** the bot has no semantic check that the lead's "answer" is plausibly an answer to a driver-qualification question. "Редактор субтитров..." is grammatically valid Russian and parses as a noun phrase — the LLM tries to make sense of it (often replies "Понятно, у вас есть водительские права?" — derailing).

**Candidate detection (regex):**

```javascript
/^\s*[Рр]едактор\s+субтитров.{0,80}?[Кк]орректор\s+/u
```

Anchors at start (these hallucinations are always the entire utterance, never embedded in a longer phrase). Bounded between-match width (≤80 chars) prevents matching real sentences that happen to mention both words.

**False positive risk: near-zero.** Real leads asked "do you have a driver's license?" do not respond with "Редактор субтитров Корректор" — the phrase pattern is unique to subtitle credits and has zero overlap with driver-qualification dialog. Risk would be a comedian or someone misunderstanding the call as a video-production-related conversation, both vanishingly rare.

**Future mitigation:** drop the STT final entirely. Do NOT feed to LLM. Treat as silence (let the silence-timeout machinery handle pacing). Emit `stt_suspicious_pattern{pattern_name='subtitle_credits'}`.

---

### 3.2 `bot_greeting_echo`

**Mono mix-type acoustic leak surviving the 500 ms post-speak grace window.** The bot ends a sentence with a word; STT processes audio from the trailing end of that TTS playback (after the `acceptSttAfter` window expires but before the audio fully decays on the line) and returns just the trailing word as if it were a lead utterance.

**Observed phrases (real, all standalone single-word "answers"):**

```
"жить."         ← echo of "продол·жить?" tail
"судить."       ← echo of "об·судить?" tail
"обсудить."     ← echo of "минуту обсудить?" tail
"слышал."       ← echo of "Не рас·слышал, повторите?" tail
"трубить."      ← echo of a word ending in "·бить"
```

The pattern: the "lead's answer" is exactly the last 2-3 syllables of the bot's most recent utterance.

**Why dangerous:** the bot interprets these as the lead saying something nonsensical. The most common outcome is the LLM saying "Понял, спасибо что уделили время" (interpreting the nonsense as a polite goodbye) and ending the call with `qualification_status='not_qualified'` or `unclear`. This is **silent corruption of the conversion funnel** — lead never spoke, but call is closed as "lead refused."

The mono mix-type and 500 ms post-speak grace window already mitigate this for most cases; the remaining leak is when STT finalizes a chunk that started inside the grace window and ended outside.

**Candidate detection (heuristic, not pure regex):**

```javascript
function looksLikeEcho({ sttText, lastAssistantText, msSinceTtsEnd }) {
    // Heuristic: STT final is short, occurs soon after TTS ended, and
    // is an exact suffix of the bot's last utterance.
    if (msSinceTtsEnd > 3000) return false           // too late to be echo
    const text = sttText.trim().replace(/[.,!?]$/, '').toLowerCase()
    if (text.split(/\s+/).length > 3) return false   // long → probably real
    const bot = (lastAssistantText ?? '').trim().toLowerCase()
    if (!bot) return false
    // Exact suffix match, ≥ 3 chars.
    return text.length >= 3 && bot.endsWith(text)
}
```

Requires the bridge to track the **time since the last TTS playback ended** (already partially tracked via `acceptSttAfter`) and the **last assistant utterance text** (already in `messages[]`).

**False positive risk: moderate.**

- A lead echoing the bot's last word as confirmation ("обсудить?" → "обсудить.") is rare but possible.
- A lead saying a short word that happens to be a suffix of a Russian compound (e.g., "не" → matches end of many words) — mitigated by the ≥3-char minimum and exact-suffix requirement.

**Future mitigation:** flag as suspicious but do NOT auto-drop. Emit the event. Operator decides based on accumulated data whether to escalate to dropping. The mono mix-type + grace window already does most of the work; this pattern catches the long tail.

---

### 3.3 `phonetic_mishearing`

**STT confused a domain-specific word for a phonetically similar everyday word.** Specific to the driver-qualification scenario.

**Observed phrases:**

```
"Водительский бассейн"            ← from "водительские права с..."
"Учительские права"               ← from "Водительские права"
"Водительский институт"           ← from "Водительские права..."
```

The phonetic confusable: `во-` ↔ `у-` initial syllables (`водительск`/`учительск`), plus tail mangling on indistinct trailing consonants.

**Why dangerous:** unlike garbage credits, mishearing produces **superficially plausible** answers that the LLM may try to interpret. "Водительский бассейн" could be (incorrectly) understood as the lead saying something about a driver-related-pool, leading the bot into off-script discussion before recovering.

**Candidate detection: HARD.** This is the riskiest pattern to detect because the line between "lead misspoke and STT got it right" vs "lead spoke correctly and STT got it wrong" is genuinely ambiguous without scenario context. Two approaches, both imperfect:

1. **Confidence threshold:** If STT confidence is below ~0.5 AND the text contains words like "бассейн"/"институт"/"учительск" that have low overlap with the qualification dictionary (license / experience / car / shift / city / week), flag as suspicious.

2. **Domain-vocab anchor:** Maintain a whitelist of scenario-relevant nouns (водительские, права, стаж, опыт, машина, аренда, день, ночь, смена). If STT returns a short utterance dominated by non-whitelist nouns AND confidence is low, flag.

Both are imperfect; both produce false positives.

**False positive risk: high.** A genuinely confused lead might say "Я не знаю, водительский институт что ли?" — a real question. Filtering this loses the lead.

**Future mitigation:** **do not filter.** Emit the event for observability only. Use the event to track scenario-vocabulary drift over time. The fix is upstream: scenario design and STT model tuning, not bridge-side filtering.

---

### 3.4 `random_name_insertion`

STT occasionally outputs a 1-2 word Russian name unrelated to the dialog. Possible cause: STT model biased toward names from training data when audio quality is poor.

**Observed phrases:**

```
"Игорь Негода."           ← random name, no preceding name context
"Алексей Шилов."
```

**Why dangerous:** the LLM may interpret as "the lead introduced themselves" — replies with "Здравствуйте, [name]!" using the wrong name, confusing/alienating the real lead. Also pollutes any future name-extraction analytics.

**Candidate detection:**

```javascript
function looksLikeRandomName(sttText) {
    const trimmed = sttText.trim().replace(/[.,!?]$/, '')
    const words = trimmed.split(/\s+/)
    if (words.length !== 2) return false
    // Russian first-name capitalized + Russian last-name capitalized.
    const namePattern = /^[А-ЯЁ][а-яё]{2,15}$/
    return words.every(w => namePattern.test(w))
}
```

**False positive risk: HIGH.** If the lead actually introduces themselves ("Меня зовут Игорь Шилов" — STT may strip the prefix and return just "Игорь Шилов"), filtering is wrong. The driver-qualification scenario does NOT ask for the lead's name explicitly, but leads volunteer names sometimes.

**Future mitigation:** flag as suspicious but never auto-drop. Pair with STT confidence: low confidence + 2-word capitalized = stronger signal. The Conversation Intelligence Layer's `payload.matched_text` allows the operator to spot-check.

---

### 3.5 `non_russian_garbage`

Emoji, Latin characters, transliterations, or other clearly non-Russian-speech artifacts.

**Observed phrases:**

```
"😎"
"OK ok ok"   (Latin OK, lead never said this)
"Listen listen"
```

**Why dangerous:** emoji in audio transcript is by definition garbage — there is no human pronunciation that produces an emoji. Latin characters in a Russian dialog are suspect though not impossible (loan words like "ОК" exist, but they're rare).

**Candidate detection (regex):**

```javascript
function looksLikeNonRussianGarbage(sttText) {
    const text = sttText.trim()
    if (!text) return false
    // Any emoji character or pictographic symbol.
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return true
    // No Cyrillic at all? Suspect — but allow short loan words like "ОК".
    if (!/[А-Яа-яЁё]/u.test(text) && text.length > 3) return true
    return false
}
```

**False positive risk: low for emoji, low-moderate for pure-Latin text.** A lead saying "OK" in Russian could be transcribed as "ОК" in Cyrillic or "OK" in Latin depending on STT mood; filtering the Latin variant loses real signal.

**Future mitigation:** emoji → drop. Pure-Latin >3 chars → flag (event), do not drop. Mixed Latin/Cyrillic → ignore (real loan words).

---

## 4. Pattern summary table

| pattern_name | observed phrases | regex / heuristic complexity | false positive risk | recommended action |
|---|---|---|---|---|
| `subtitle_credits` | "Редактор субтитров А.X Корректор А.Y" | simple regex | near-zero | **drop + emit event** |
| `bot_greeting_echo` | "жить.", "судить.", suffix-of-bot | requires bridge state (lastAssistantText + msSinceTtsEnd) | moderate | **emit event** (drop only after data) |
| `phonetic_mishearing` | "Водительский бассейн", "Учительские права" | confidence + scenario-vocab | **high** | emit event only — do not filter |
| `random_name_insertion` | "Игорь Негода", "Алексей Шилов" | name regex | high | emit event only |
| `non_russian_garbage` | "😎", "OK ok ok" | unicode class | low (emoji) / moderate (latin) | drop emoji, flag latin |

---

## 5. How this feeds future PRs

### 5.1 Immediate: the `stt_suspicious_pattern` event matcher

In the Conversation Intelligence Layer implementation PR, the bridge gains a `_classifyStt(text, ctx)` helper that runs incoming STT finals through these patterns. Matches emit a `stt_suspicious_pattern` event with `pattern_name` set to one of the 5 above. **No filtering yet — observation only.**

Inputs the matcher will need from `call-session.js`:

- `text` — the STT final
- `lastAssistantText` — `this.messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content`
- `msSinceTtsEnd` — `Date.now() - (this.acceptSttAfter - this.POST_SPEAK_GRACE_MS)` (the moment TTS playback ended)
- `sttConfidence` — currently not surfaced; would require a small `stt-router.js` change to propagate

The matcher itself is a pure function — testable as a CommonJS module the same shape as PR #57's `outcome-mapper.js` and `scenario-schema.js`.

### 5.2 Later: the STT garbage filter

After 2-4 weeks of event data:

- For patterns with confirmed near-zero false-positive rate (`subtitle_credits`, `non_russian_garbage` emoji): bridge drops the STT final before it reaches `pendingUserText`. The bot continues listening as if nothing was said.
- For higher-risk patterns: the event continues to fire, but no filtering until operator-confirmed signal.

The filter is a single conditional in `_onSttFinal` after the matcher runs:

```javascript
// Pseudocode for the FILTER PR (not this PR, not the implementation PR)
const classification = classifyStt(trimmed, ctx)
if (classification.match) {
    emit('stt_suspicious_pattern', classification)
    if (classification.action === 'drop') {
        console.log(`[call ${this.callUuid}] stt-drop (${classification.pattern_name}): ${trimmed.slice(0, 60)}`)
        return
    }
}
```

Action is set per-pattern based on accumulated false-positive data.

---

## 6. Scope boundary

What this research doc is:
- A catalog of observed patterns from production data
- Regex / heuristic candidates with explicit false-positive risk assessment
- A reference for the `stt_suspicious_pattern` event matcher in the future implementation PR

What this research doc is NOT:
- An implementation. No code is committed by this doc.
- A final filter design. The filter follows later, motivated by event data.
- A complete pattern list. The catalog will grow as more production calls accumulate; each addition follows the same template (observed phrase, regex, false-positive risk, recommended action).
