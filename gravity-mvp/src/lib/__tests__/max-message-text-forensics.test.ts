import { describe, expect, test } from 'vitest'
import { buildMaxTextRepairDryRun, inspectMaxMessageText } from '../max-message-text-forensics'

describe('MAX message text forensic classifier', () => {
  test('keeps a normal operator text clean and recoverable', () => {
    expect(inspectMaxMessageText('Здравствуйте! Напишите, пожалуйста, номер парка.')).toEqual({
      kind: 'clean',
      recoverable: true,
      requiresManualReview: false,
      reasons: [],
      textLength: 48,
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
      byKind: { clean: 1, combined: 1, empty: 1 },
    })
    expect(report.candidates).toEqual([
      expect.objectContaining({ messageId: 'bad', result: expect.objectContaining({ kind: 'combined' }) }),
    ])
  })
})
