import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync('../scripts/personal-max-eldar-history-reconcile-v1.sh', 'utf8')

describe('Personal MAX exact-history repair script', () => {
  it('is checksum and immutable provider-snapshot bound', () => {
    expect(source).toContain('EXPECTED_SCRIPT_SHA')
    expect(source).toContain('EXPECTED_SNAPSHOT_SHA=932c3fbe')
    expect(source).toContain('historyLoad.lastScroll.atTop == true')
    expect(source).toContain('historyLoad.stalledAttempts >= 4')
    expect(source).toContain('(.messages | length) == 22')
  })

  it('repairs by provider id and preserves audit evidence', () => {
    expect(source).toContain('JOIN "Message" m ON m."externalId"=p.provider_message_id')
    expect(source).toContain('personal_max_history_repair_v1')
    expect(source).toContain("visibility','suppressed_duplicate'")
    expect(source).toContain("visibility','suppressed_provider_absent'")
    expect(source).toContain('availableHistoryExhausted')
  })

  it('contains no MAX/provider action or blind retry primitive', () => {
    expect(source).not.toMatch(/history\/snapshot|sendProviderConfirmed|\/send\/text|forwardToWebhook/)
    expect(source).not.toMatch(/curl|wget|fetch\(/)
    expect(source).not.toMatch(/docker compose|docker restart|docker kill/)
  })
})
