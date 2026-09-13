/**
 * Boundary acceptance for the two pilot surfaces.
 *
 * The decisions are proven elsewhere. What has to be established here is that
 * the real Telegram scene and the real manager screen reach those decisions
 * rather than reimplementing them: a surface that quietly grew its own copy of
 * the cap or the eligibility rule would pass every other test in the suite and
 * still pay the wrong driver.
 *
 * These read the shipped source, in the same style as the existing bot profile
 * boundary test.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../../../../../..')
const read = (relative: string) => readFileSync(path.join(REPO, relative), 'utf8')

const SCENE = read('tg-bot/src/handlers/compensation.js')
const MENU = read('tg-bot/src/handlers/menu.js')
const BOT = read('tg-bot/src/bot.js')
const ROUTE = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const MANAGER_ACTIONS = read('gravity-mvp/src/app/compensation/actions.ts')
const MANAGER_LIST = read('gravity-mvp/src/app/compensation/CompensationApplicationList.tsx')

describe('the telegram scene is reachable and registered', () => {
    it('has a compensation entry on the main menu', () => {
        expect(MENU).toContain('💰 Компенсация наличных')
        expect(MENU).toContain("ctx.scene.enter('compensation')")
    })

    it('is registered on the bot stage', () => {
        expect(BOT).toContain("require('./handlers/compensation')")
        expect(BOT).toContain('compensationScene')
    })
})

describe('the telegram scene calls the backend for every decision', () => {
    it('asks the CRM for the section rather than building a list itself', () => {
        expect(SCENE).toContain("callCRM('compensation_section'")
    })

    it('submits through the CRM with the full evidence payload', () => {
        expect(SCENE).toContain("callCRM('compensation_submit'")
        for (const field of [
            'externalOrderId', 'claimedRubles', 'supportConfirmed',
            'attachmentFileId', 'attachmentKind', 'idempotencyKey',
        ]) {
            expect(SCENE).toContain(field)
        }
    })

    it('sends a stable idempotency key so a retried tap is one submit', () => {
        expect(SCENE).toContain('crypto.randomUUID()')
        expect(SCENE).toContain('idempotencyKey: ctx.scene.state.idempotencyKey')
    })

    it('collects both an attachment kind the pilot accepts', () => {
        expect(SCENE).toContain("compensationScene.on('photo'")
        expect(SCENE).toContain("compensationScene.on('document'")
    })

    it('renders every refusal the backend can return', () => {
        for (const refusal of [
            'identity_not_proven', 'not_self_employed', 'self_employment_unknown',
            'outside_first_calendar_month', 'support_not_confirmed', 'attachment_missing',
            'claim_above_pilot_cap', 'order_not_in_catalogue', 'order_already_claimed',
            'budget_exhausted',
        ]) {
            expect(SCENE).toContain(refusal)
        }
    })

    it('shows the remaining monthly budget and the driver statuses', () => {
        expect(SCENE).toContain('remainingBudgetKopecks')
        for (const status of ['submitted', 'awaiting_payment', 'paid', 'rejected']) {
            expect(SCENE).toContain(status)
        }
    })

    it('never decides eligibility or reads compensation tables itself', () => {
        // Naming a refusal code such as hire_date_unknown is rendering, not
        // deciding, so the check is for the driver fields themselves and for
        // any direct reach into storage.
        expect(SCENE).not.toContain('isSelfEmployed')
        expect(SCENE).not.toContain('employmentType')
        expect(SCENE).not.toContain('parkHireDate')
        expect(SCENE).not.toContain('yandexHireDate')
        expect(SCENE).not.toMatch(/prisma|CompensationCashOrder|CompensationApplication/)
        // Eligibility words appear only as refusal keys inside the label table.
        expect(SCENE).toContain('not_self_employed:')
        expect(SCENE).toContain('hire_date_unknown:')
    })

    it('treats the local amount check as courtesy, still sending it for refusal', () => {
        // The scene may stop an obviously wrong number to keep the chat moving,
        // but the claim still goes to the CRM, whose answer is authoritative.
        expect(SCENE).toContain('Максимум 1000 ₽')
        expect(SCENE).toContain("callCRM('compensation_submit'")
    })
})

describe('the webhook routes those actions to the service', () => {
    it('dispatches both compensation actions', () => {
        expect(ROUTE).toContain("case 'compensation_section':")
        expect(ROUTE).toContain("case 'compensation_submit':")
    })

    it('calls the pilot service and nothing lower', () => {
        expect(ROUTE).toContain('compensationPilotSectionV1')
        expect(ROUTE).toContain('compensationPilotSubmitV1')
        expect(ROUTE).toContain("from '@/modules/fleet-operations/application/compensation-pilot-operations'")
    })

    it('refuses a submit with no idempotency key instead of inventing one', () => {
        // Inventing a key would turn a retried tap into a second application.
        expect(ROUTE).toContain("Missing idempotencyKey")
    })

    it('does not reach into the monetary core from the route', () => {
        expect(ROUTE).not.toContain('compensation-prisma-adapter')
        expect(ROUTE).not.toContain('submitCompensationApplicationV1')
    })
})

describe('the manager screen acts only through the service', () => {
    it('lists and acts through the pilot operations module', () => {
        expect(MANAGER_ACTIONS).toContain('compensationManagerApplicationsV1')
        expect(MANAGER_ACTIONS).toContain('compensationManagerActionV1')
        expect(MANAGER_ACTIONS).toContain("from '@/modules/fleet-operations/application/compensation-pilot-operations'")
    })

    it('offers approve, reject and mark paid, and nothing else', () => {
        expect(MANAGER_ACTIONS).toContain("action: 'approve'")
        expect(MANAGER_ACTIONS).toContain("action: 'reject'")
        expect(MANAGER_ACTIONS).toContain("action: 'mark_paid'")
    })

    it('never calls a C1 entry point directly', () => {
        for (const forbidden of [
            'startCompensationPayoutV1', 'finalizeCompensationPayoutV1',
            'rejectCompensationApplicationV1', 'compensation-prisma-adapter',
        ]) {
            expect(MANAGER_ACTIONS).not.toContain(forbidden)
        }
    })

    it('shows the person, park, order, both amounts and the attachment', () => {
        for (const field of [
            'canonicalContactId', 'externalParkId', 'externalOrderId',
            'requestedKopecks', 'verifiedKopecks', 'attachmentFileId',
        ]) {
            expect(MANAGER_ACTIONS).toContain(field)
        }
    })

    it('surfaces reconciliation when C1 requires it', () => {
        expect(MANAGER_ACTIONS).toContain('hasOpenReconciliation')
        expect(MANAGER_LIST).toContain('hasOpenReconciliation')
        expect(MANAGER_LIST).toContain('Требуется сверка')
    })

    it('requires a typed reason before rejecting', () => {
        expect(MANAGER_LIST).toContain("reason.trim() === ''")
    })

    it('renders the refusal codes the service can return', () => {
        for (const refusal of [
            'approve_requires_pending', 'reject_requires_no_live_authorization',
            'mark_paid_requires_authorization', 'reject_requires_reason',
        ]) {
            expect(MANAGER_LIST).toContain(refusal)
        }
    })
})
