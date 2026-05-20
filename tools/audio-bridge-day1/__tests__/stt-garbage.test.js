// Unit regression for the STT garbage classifier (PR #60).
//
// Locks the FP-risk contract: patterns documented in
// docs/research/stt-garbage-patterns.md as near-zero or low FP risk
// are dropped; everything else passes through. Real Russian
// conversation MUST never match.
//
// Run: `node --test __tests__/stt-garbage.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    classifySttGarbage,
    SUBTITLE_CREDITS_RE,
    EMOJI_RE,
} = require('../stt-garbage')

// ════════════════════════════════════════════════════════════════════
// Defensive: empty / non-string inputs
// ════════════════════════════════════════════════════════════════════

test('empty string → not suspicious', () => {
    assert.equal(classifySttGarbage('').suspicious, false)
})

test('whitespace-only → not suspicious', () => {
    assert.equal(classifySttGarbage('   \t\n  ').suspicious, false)
})

test('null / undefined / non-string → not suspicious (defensive)', () => {
    assert.equal(classifySttGarbage(null).suspicious, false)
    assert.equal(classifySttGarbage(undefined).suspicious, false)
    assert.equal(classifySttGarbage(42).suspicious, false)
    assert.equal(classifySttGarbage({}).suspicious, false)
})

// ════════════════════════════════════════════════════════════════════
// Pattern 1: subtitle_credits — REAL observed phrases from production
// ════════════════════════════════════════════════════════════════════

test('subtitle_credits: classic "Редактор субтитров А.Синецкая Корректор А.Егорова"', () => {
    const r = classifySttGarbage('Редактор субтитров А.Синецкая Корректор А.Егорова')
    assert.equal(r.suspicious, true)
    assert.equal(r.action, 'drop')
    assert.equal(r.pattern_name, 'subtitle_credits')
})

test('subtitle_credits: variant "Редактор субтитров А.Семкин Корректор А.Егорова"', () => {
    const r = classifySttGarbage('Редактор субтитров А.Семкин Корректор А.Егорова')
    assert.equal(r.suspicious, true)
    assert.equal(r.pattern_name, 'subtitle_credits')
})

test('subtitle_credits: lowercase variant', () => {
    const r = classifySttGarbage('редактор субтитров А.Иванов корректор А.Петрова')
    assert.equal(r.suspicious, true)
    assert.equal(r.pattern_name, 'subtitle_credits')
})

test('subtitle_credits: leading whitespace still matches', () => {
    const r = classifySttGarbage('   Редактор субтитров А.X Корректор А.Y ')
    assert.equal(r.suspicious, true)
    assert.equal(r.pattern_name, 'subtitle_credits')
})

// FP risk floor: real driver-qualification utterances mentioning the words
// must NOT match.
test('subtitle_credits: "я редактор журнала" must NOT match (no корректор)', () => {
    assert.equal(classifySttGarbage('я редактор журнала по специальности').suspicious, false)
})

test('subtitle_credits: "корректор зрения" alone must NOT match (no редактор+субтитров)', () => {
    assert.equal(classifySttGarbage('у меня корректор зрения').suspicious, false)
})

test('subtitle_credits: "субтитры" alone must NOT match', () => {
    assert.equal(classifySttGarbage('я смотрю фильмы с субтитрами').suspicious, false)
})

// ════════════════════════════════════════════════════════════════════
// Pattern 2: non_russian_garbage — emoji
// ════════════════════════════════════════════════════════════════════

test('non_russian_garbage: standalone emoji 😎', () => {
    const r = classifySttGarbage('😎')
    assert.equal(r.suspicious, true)
    assert.equal(r.action, 'drop')
    assert.equal(r.pattern_name, 'non_russian_garbage')
})

test('non_russian_garbage: thumbs-up 👍', () => {
    assert.equal(classifySttGarbage('👍').suspicious, true)
})

test('non_russian_garbage: heart ❤', () => {
    assert.equal(classifySttGarbage('❤').suspicious, true)
})

test('non_russian_garbage: emoji embedded in text still flagged', () => {
    // Emoji anywhere in the string is a strong signal of garbage —
    // STT outputting any emoji means the input was not natural speech.
    assert.equal(classifySttGarbage('Hello 😎 world').suspicious, true)
})

// ════════════════════════════════════════════════════════════════════
// Pattern 2: non_russian_garbage — pure-non-Cyrillic > 3 chars
// ════════════════════════════════════════════════════════════════════

test('non_russian_garbage: "OK ok ok" (Latin > 3 chars, no Cyrillic)', () => {
    const r = classifySttGarbage('OK ok ok')
    assert.equal(r.suspicious, true)
    assert.equal(r.pattern_name, 'non_russian_garbage')
})

test('non_russian_garbage: "Listen listen" (Latin > 3 chars)', () => {
    assert.equal(classifySttGarbage('Listen listen').suspicious, true)
})

// ── FP risk floor: short Latin loan words and mixed-script must pass ──

test('Cyrillic "ОК" (2 chars) must NOT match (short loan word)', () => {
    assert.equal(classifySttGarbage('ОК').suspicious, false)
})

test('Latin "OK" (2 chars) must NOT match (< 4 chars threshold)', () => {
    assert.equal(classifySttGarbage('OK').suspicious, false)
})

test('Latin "Yes" (3 chars) must NOT match (≤ 3 chars threshold)', () => {
    assert.equal(classifySttGarbage('Yes').suspicious, false)
})

test('Mixed Latin/Cyrillic "iPhone 12 уже есть" must NOT match', () => {
    assert.equal(classifySttGarbage('iPhone 12 уже есть').suspicious, false)
})

test('Mixed Latin/Cyrillic "Я работаю в Uber" must NOT match', () => {
    assert.equal(classifySttGarbage('Я работаю в Uber').suspicious, false)
})

// ════════════════════════════════════════════════════════════════════
// Normal Russian speech — must ALL pass through (zero false positives)
// ════════════════════════════════════════════════════════════════════

test('normal Russian: "да удобно" passes', () => {
    assert.equal(classifySttGarbage('да удобно').suspicious, false)
})

test('normal Russian: "Есть права категории B, стаж 5 лет" passes', () => {
    assert.equal(classifySttGarbage('Есть права категории B, стаж 5 лет').suspicious, false)
})

test('normal Russian: "Интересует аренда" passes', () => {
    assert.equal(classifySttGarbage('Интересует аренда').suspicious, false)
})

test('normal Russian: "Хочу работать днём в Москве" passes', () => {
    assert.equal(classifySttGarbage('Хочу работать днём в Москве').suspicious, false)
})

test('normal Russian: single word "да" passes', () => {
    assert.equal(classifySttGarbage('да').suspicious, false)
})

test('normal Russian: "Уже работаю в другом парке" passes', () => {
    assert.equal(classifySttGarbage('Уже работаю в другом парке').suspicious, false)
})

// ════════════════════════════════════════════════════════════════════
// Action shape contract
// ════════════════════════════════════════════════════════════════════

test('non-suspicious classification has null action and null pattern_name', () => {
    const r = classifySttGarbage('здравствуйте')
    assert.equal(r.action, null)
    assert.equal(r.pattern_name, null)
})

test('suspicious classification always has action=drop in v1 (no flag patterns yet)', () => {
    // v1 ships ONLY 'drop' patterns. If a future PR adds a 'flag'
    // pattern (emit event but don't suppress), this test must be
    // updated alongside the FP risk justification in the research doc.
    const cases = [
        'Редактор субтитров А.Х Корректор А.Y',
        '😎',
        'OK ok ok',
    ]
    for (const text of cases) {
        const r = classifySttGarbage(text)
        assert.equal(r.suspicious, true, text)
        assert.equal(r.action, 'drop', text)
    }
})
