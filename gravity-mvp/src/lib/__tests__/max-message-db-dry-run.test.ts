import { describe, expect, test, vi } from 'vitest'
import { collectMaxMessageTextDryRun } from '../../../scripts/max-message-text-dry-run'

describe('MAX message DB dry-run', () => {
  test('reads MAX rows in pages and produces no write instruction', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([
        {
          id: 'one',
          content: 'Обычный текст',
          metadata: {},
          _count: { attachments: 0 },
        },
        {
          id: 'two',
          content: '[↩ 700777:Источник]\nСохраненный текст',
          metadata: { forwardedFrom: { id: '700777', name: 'Источник' } },
          _count: { attachments: 0 },
        },
      ])
      .mockResolvedValueOnce([])

    const result = await collectMaxMessageTextDryRun(
      { message: { findMany } },
      2,
    )

    expect(findMany).toHaveBeenCalledTimes(2)
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { channel: 'max' },
      take: 2,
    })
    expect(findMany.mock.calls[1][0]).toMatchObject({
      cursor: { id: 'two' },
      skip: 1,
    })
    expect(result).toMatchObject({
      source: 'read_only_database',
      report: {
        total: 2,
        clean: 1,
        recoverableCandidates: 1,
        reviewRequired: 0,
      },
    })
    expect(result.report.candidates[0].result).toMatchObject({
      proposedReplacement: 'Сохраненный текст',
      confidence: 'high',
    })
    expect(JSON.stringify(result)).not.toContain('"write"')
  })
})
