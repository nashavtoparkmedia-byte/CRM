import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildMaxTextRepairDryRun, inspectMaxMessageText } from '../max-message-text-forensics'

describe('MAX message text forensic classifier', () => {
  test('keeps a normal operator text clean and recoverable', () => {
    expect(inspectMaxMessageText('Здравствуйте! Напишите, пожалуйста, номер парка.')).toMatchObject({
      kind: 'clean',
      recoverable: true,
      requiresManualReview: false,
      reasons: [],
      proposedReplacement: null,
      confidence: 'none',
    })
  })

  test('does not silently repair invalid encoding', () => {
    const result = inspectMaxMessageText('Р�Р�')

    expect(result).toMatchObject({
      kind: 'replacement_character',
      recoverable: false,
      requiresManualReview: true,
      reasons: ['replacement_character'],
    })
  })

  test('separates raw attachment and metadata fragments from normal text', () => {
    expect(inspectMaxMessageText('attachments: [{"url":"internal"}]')).toMatchObject({
      kind: 'raw_attachment_fragment',
      requiresManualReview: true,
    })
    expect(inspectMaxMessageText('prevM={"senderId":"internal"}')).toMatchObject({
      kind: 'raw_metadata_fragment',
      requiresManualReview: true,
    })
  })

  test('reports mixed corruption as one manual-review candidate', () => {
    const report = buildMaxTextRepairDryRun([
      { id: 'clean', content: 'Готово' },
      { id: 'bad', content: '� attachments: [] prevM={}' },
      { id: 'empty', content: '' },
    ])

    expect(report).toMatchObject({
      total: 3,
      clean: 1,
      reviewRequired: 1,
      recoverableCandidates: 0,
      byKind: { clean: 1, combined: 1, empty: 1 },
    })
    expect(report.candidates).toEqual([
      expect.objectContaining({ messageId: 'bad', result: expect.objectContaining({ kind: 'combined' }) }),
    ])
  })

  test('proposes only a deterministic legacy forwarding-prefix repair', () => {
    const report = buildMaxTextRepairDryRun([
      {
        id: 'matched-forward',
        content: '[↩ 700777:Источник]\nСохраненный текст',
        metadata: { forwardedFrom: { id: '700777', name: 'Источник' } },
      },
      {
        id: 'unproven-forward',
        content: '[↩ Неизвестно]\nТекст',
        metadata: {},
      },
    ])

    expect(report).toMatchObject({
      total: 2,
      recoverableCandidates: 1,
      reviewRequired: 1,
      byKind: { legacy_forward_prefix: 2 },
    })
    expect(report.candidates[0]).toEqual(expect.objectContaining({
      messageId: 'matched-forward',
      result: expect.objectContaining({
        recoverable: true,
        proposedReplacement: 'Сохраненный текст',
        confidence: 'high',
      }),
    }))
    expect(report.candidates[1]).toEqual(expect.objectContaining({
      messageId: 'unproven-forward',
      result: expect.objectContaining({
        recoverable: false,
        proposedReplacement: null,
        confidence: 'none',
      }),
    }))
  })

  test('classifies every saved known-damaged fixture without inventing text', () => {
    const fixtures = JSON.parse(readFileSync(
      resolve(process.cwd(), '..', 'max-web-scraper', 'forensics', 'fixtures', 'known-damaged.json'),
      'utf8',
    ))
    const report = buildMaxTextRepairDryRun(fixtures)

    expect(report).toMatchObject({
      total: 4,
      reviewRequired: 3,
      recoverableCandidates: 1,
      byKind: {
        replacement_character: 1,
        raw_attachment_fragment: 1,
        raw_metadata_fragment: 1,
        legacy_forward_prefix: 1,
      },
    })
    expect(report.candidates.filter(candidate => candidate.result.proposedReplacement)).toHaveLength(1)
  })
})
