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

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
const read = (relative: string) => readFileSync(path.join(REPO, relative), 'utf8')

const SCENE = read('tg-bot/src/handlers/compensation.js')
const MENU = read('tg-bot/src/handlers/start.js')
const BOT = read('tg-bot/src/bot.js')
const ROUTE = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const MANAGER_ACTIONS = read('gravity-mvp/src/app/compensation/actions.ts')
const MANAGER_DATA = read('gravity-mvp/src/app/compensation/manager-data.ts')
const MANAGER_BOARD = read('gravity-mvp/src/app/compensation/page.tsx')
const MANAGER_LIST = read('gravity-mvp/src/app/compensation/CompensationApplicationList.tsx')
const MANAGER_FILTERS = read('gravity-mvp/src/app/compensation/CompensationFilters.tsx')
const MANAGER_BUDGET = read('gravity-mvp/src/app/compensation/CompensationBudgetPanel.tsx')
const MANAGER_DETAIL = read('gravity-mvp/src/app/compensation/[applicationId]/CompensationApplicationDetail.tsx')
const MANAGER_DETAIL_PAGE = read('gravity-mvp/src/app/compensation/[applicationId]/page.tsx')
const EVIDENCE_ROUTE = read('gravity-mvp/src/app/compensation/[applicationId]/evidence/route.ts')
const BOT_FILE_ROUTE = read('tg-bot/src/routes/crm.js')
const BOT_FILE_SERVICE = read('tg-bot/src/services/exactCrmBotFile.js')
const MANAGER_SCREENS = [
    MANAGER_ACTIONS, MANAGER_DATA, MANAGER_BOARD, MANAGER_LIST,
    MANAGER_FILTERS, MANAGER_BUDGET, MANAGER_DETAIL, MANAGER_DETAIL_PAGE,
]

describe('the telegram scene is reachable and registered', () => {
    it('has a compensation entry on the main menu', () => {
        expect(MENU).toContain('💰 Компенсация наличных')
        expect(MENU).toContain("ctx.scene.enter('compensation')")
    })

    it('interrupts any active scene or connection mode, so the entry works from every state', () => {
        // Without this, an abandoned compensation step or the connection flow
        // swallows the tap before the main-menu fallback ever sees it.
        const staticButtons = BOT.slice(BOT.indexOf('const staticButtons = ['), BOT.indexOf('];', BOT.indexOf('const staticButtons = [')))
        expect(staticButtons).toContain("'💰 Компенсация наличных'")
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

    it('binds every call to the receiving bot account, as every bot Driver action does', () => {
        expect(SCENE).toContain("require('../services/exactTelegramActionBinding')")
        // One payload builder carries the binding, and every CRM call uses it.
        expect(SCENE.match(/\.\.\.exactTelegramActionBinding\(ctx\)/g) ?? []).toHaveLength(1)
        const calls = SCENE.match(/callCRM\('[a-z_]+', [^)]*\)?/g) ?? []
        expect(calls.length).toBeGreaterThanOrEqual(5)
        for (const call of calls) expect(call).toContain('crmPayload(ctx')
    })

    it('asks the CRM about a chosen order and for a refresh instead of deciding either', () => {
        expect(SCENE).toContain("callCRM('compensation_order_check'")
        expect(SCENE).toContain("callCRM('compensation_refresh'")
        // The scope token the CRM issued with the list goes back with the
        // order and with the claim.
        expect(SCENE).toContain('comp_o:${scopeKey}:${order.externalOrderId}')
        expect(SCENE).toMatch(/compensation_order_check', crmPayload\(ctx, \{ externalOrderId, scopeKey, retry \}\)/)
        expect(SCENE).toContain('scopeKey: state.scopeKey')
    })

    it('never reaches Yandex or waits in a handler', () => {
        expect(SCENE).not.toMatch(/fleet-api|yandex\.net|fetch\(|setTimeout|setInterval|sleep/)
    })

    it('answers a compensation button with no open scene as stale', () => {
        const stage = BOT.indexOf('bot.use(stage.middleware())')
        const stale = BOT.indexOf('bot.action(/^comp_/, compensationStaleCallback)')
        const globalCallbacks = BOT.indexOf("bot.on('callback_query'")
        expect(stage).toBeGreaterThan(-1)
        expect(stale).toBeGreaterThan(stage)
        expect(globalCallbacks).toBeGreaterThan(stale)
        expect(SCENE).toContain('async function compensationStaleCallback(ctx)')
    })

    it('tells a driver whose chat authority was refused something other than "share your number"', () => {
        expect(SCENE).toContain('error.status === 409')
        expect(SCENE).toContain('AUTHORITY_REFUSED_TEXT')
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
            'identity_not_proven', 'identity_needs_review', 'identity_busy',
            'not_self_employed', 'self_employment_unknown',
            'outside_first_calendar_month', 'support_not_confirmed', 'attachment_missing',
            'claim_above_pilot_cap', 'order_not_in_catalogue', 'order_already_claimed',
            'budget_exhausted', 'active_pending_exists', 'submission_window_closed',
            'park_not_selected', 'selected_park_profile_unproven', 'catalogue_disabled',
            'stale_context', 'order_confirmation_pending', 'order_not_confirmed',
            'order_check_failed', 'order_check_unavailable',
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
    it('dispatches every compensation action', () => {
        expect(ROUTE).toContain("case 'compensation_section':")
        expect(ROUTE).toContain("case 'compensation_submit':")
        expect(ROUTE).toContain("case 'compensation_order_check':")
        expect(ROUTE).toContain("case 'compensation_refresh':")
    })

    it('takes the selected park from the proven link, never from the bot', () => {
        const block = ROUTE.slice(ROUTE.indexOf('// ── Cash compensation pilot'), ROUTE.indexOf('// Handle a phone submitted through the driver bot'))
        expect(block).toContain('select: { driverId: true, activeParkId: true }')
        expect(block).toContain('selectedExternalParkId: mapping.activeParkId ?? null')
        expect(block).not.toMatch(/payload\??\.(parkId|activeParkId|selectedExternalParkId|externalParkId)/)
    })

    it('calls the pilot service and nothing lower', () => {
        expect(ROUTE).toContain('compensationPilotSectionV1')
        expect(ROUTE).toContain('compensationPilotSubmitV1')
        expect(ROUTE).toContain('compensationPilotOrderCheckV1')
        expect(ROUTE).toContain('compensationPilotRefreshV1')
        expect(ROUTE).not.toMatch(/requestCashOrder(HotRefresh|DayConfirmation)V1|readCashOrderOrderConfirmationV1/)
        // The module public path, not the composition root: reaching past the
        // public surface is what made the whole facade read as laundering.
        expect(ROUTE).toContain("from '@/modules/fleet-operations/public/v1'")
    })

    it('proves the person through current Telegram Driver authority and writes no link', () => {
        const block = ROUTE.slice(ROUTE.indexOf('// ── Cash compensation pilot'), ROUTE.indexOf('// Handle a phone submitted through the driver bot'))
        expect(block).toContain('resolveCurrentBotDriverAuthority(payload')
        expect(block).toContain('contactId: authority.contactId')
        expect(block).not.toMatch(/driverTelegram\.(create|update|upsert|delete)/)
        expect(block).not.toMatch(/phone|BotUserRegistry|botUserRegistry|fetch\(/)
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

describe('the manager screens act only through the service', () => {
    it('reads and acts through the module public surface, never through C1', () => {
        for (const operation of [
            'compensationManagerApplicationsV1', 'compensationManagerApplicationV1',
            'compensationManagerBudgetV1', 'compensationManagerEvidenceSourceV1',
            'compensationManagerActionV1',
        ]) {
            expect(MANAGER_DATA + MANAGER_ACTIONS).toContain(operation)
        }
        expect(MANAGER_DATA).toContain("from '@/modules/fleet-operations/public/v1'")
        for (const screen of MANAGER_SCREENS) {
            for (const forbidden of [
                'startCompensationPayoutV1', 'finalizeCompensationPayoutV1',
                'releaseCompensationPayoutV1', 'resolveCompensationReconciliationV1',
                'rejectCompensationApplicationV1', 'compensation-prisma-adapter',
                "from '@/lib/prisma'",
            ]) {
                expect(screen).not.toContain(forbidden)
            }
        }
    })

    it('offers every action the workflow has, and no action it does not', () => {
        for (const action of [
            'approve', 'reject', 'mark_paid', 'cancel_approval',
            'declare_outcome_unknown', 'reconcile_paid', 'reconcile_not_paid',
        ]) {
            expect(MANAGER_ACTIONS).toContain(action)
        }
        // The screen renders whatever the service says is allowed rather than
        // deciding for itself which buttons a state deserves.
        expect(MANAGER_DETAIL).toContain('allowedActions')
    })

    it('resolves the acting manager from the session, never from the client', () => {
        expect(MANAGER_DATA).toContain('queryCurrentUserV1')
        expect(MANAGER_DATA).toContain('resolveCompensationManagerPrincipalV1')
        expect(MANAGER_ACTIONS).toContain('await managerSession()')
        // The browser sends an application id, an action and a reason. If it
        // could send a principal, a crafted post would put someone else's name
        // on a payout.
        for (const screen of [MANAGER_LIST, MANAGER_DETAIL, MANAGER_FILTERS, MANAGER_BUDGET]) {
            for (const forbidden of ['managerId', 'operatorLabel', 'principalId']) {
                expect(screen).not.toContain(forbidden)
            }
        }
    })

    it('carries no shared fallback principal anywhere in the surface', () => {
        for (const screen of MANAGER_SCREENS) {
            expect(screen).not.toMatch(/'crm_manager'|"crm_manager"/)
            expect(screen).not.toMatch(/principalId:\s*'(manager|admin|system)'/)
        }
    })

    it('requires a session and an allowed role before anything is read or done', () => {
        expect(MANAGER_DATA).toContain('MANAGER_ROLES_V1')
        for (const role of ['Менеджер', 'Руководитель', 'Администратор']) {
            expect(MANAGER_DATA).toContain(role)
        }
        expect(MANAGER_DATA).toContain("'role_not_allowed'")
        // Every entry point gates first: the board, the detail, the evidence
        // response and every action.
        for (const screen of [MANAGER_BOARD, MANAGER_DETAIL_PAGE, EVIDENCE_ROUTE, MANAGER_ACTIONS]) {
            expect(screen).toContain('managerSession()')
        }
        expect(MANAGER_ACTIONS).toContain('if (!session.ok) return')
    })

    it('stops before any monetary call when the session is refused', () => {
        const guard = MANAGER_ACTIONS.indexOf('if (!session.ok) return')
        expect(guard).toBeGreaterThan(-1)
        expect(guard).toBeLessThan(MANAGER_ACTIONS.indexOf('compensationManagerActionV1('))
    })

    it('proves the screenshot before approving, and only before approving', () => {
        // Metadata is not proof: the file is fetched now, and a failure fails
        // the approval closed. Nothing else waits on Telegram, because an
        // outage must not strand money that is already authorised.
        expect(MANAGER_ACTIONS).toContain("if (input.action === 'approve')")
        expect(MANAGER_ACTIONS).toContain('managerEvidence(input.applicationId)')
        expect(MANAGER_ACTIONS).toContain('evidenceProven')
        expect(MANAGER_ACTIONS).toContain("'evidence_unavailable'")
    })

    it('never puts the telegram file id in anything a browser receives', () => {
        // The browser asks for an application; the file id is resolved server
        // side and handed straight to the channel that holds it.
        for (const screen of MANAGER_SCREENS) {
            expect(screen).not.toContain('attachmentFileId')
            expect(screen).not.toContain('tg-media')
        }
        expect(MANAGER_DETAIL).toContain('/evidence')
        expect(MANAGER_DATA).toContain('readTelegramBotFileV1')
    })

    it('serves the screenshot as an inert private response', () => {
        expect(EVIDENCE_ROUTE).toContain("'Cache-Control': 'private, no-store'")
        expect(EVIDENCE_ROUTE).toContain("'X-Content-Type-Options': 'nosniff'")
        expect(EVIDENCE_ROUTE).toContain('sandbox')
        // The bytes are served here; the browser is never sent to Telegram.
        expect(EVIDENCE_ROUTE).not.toContain('NextResponse.redirect')
        expect(EVIDENCE_ROUTE).not.toContain('api.telegram.org')
    })

    it('keeps the bot token in the bot process, behind a signed endpoint', () => {
        expect(BOT_FILE_ROUTE).toContain("require('../services/exactCrmBotFile')")
        expect(BOT_FILE_SERVICE).toContain('x-bot-signature')
        // The gravity side never reads the token, and neither side logs it.
        for (const screen of [...MANAGER_SCREENS, EVIDENCE_ROUTE]) {
            expect(screen).not.toContain('BOT_TOKEN')
        }
        expect(BOT_FILE_SERVICE).not.toMatch(/console\.(log|error|warn)\([^)]*token/i)
        expect(BOT_FILE_SERVICE).not.toMatch(/console\.(log|error|warn)\([^)]*fileUrl/i)
    })

    it('requires a typed reason before rejecting, and confirms every other action', () => {
        expect(MANAGER_DETAIL).toContain("reason.trim() === ''")
        expect(MANAGER_DETAIL).toContain('confirmationFor')
        expect(MANAGER_DETAIL).toContain('data-testid="confirmation"')
    })

    it('renders the refusals a manager can actually hit', () => {
        for (const refusal of [
            'reject_requires_reason', 'already_paid', 'already_rejected', 'state_changed',
            'payout_authorization_active', 'daily_limit_reached', 'budget_period_missing',
            'authorization_too_old_reconcile', 'evidence_unavailable',
            'not_authenticated', 'user_disabled', 'user_identity_incomplete', 'role_not_allowed',
        ]) {
            expect(MANAGER_DETAIL + MANAGER_BOARD + MANAGER_DETAIL_PAGE).toContain(refusal)
        }
    })

    it('shows the month the ledger holds, including when there is no period at all', () => {
        expect(MANAGER_BUDGET).toContain('remainingKopecks')
        expect(MANAGER_BUDGET).toContain('reservedKopecks')
        expect(MANAGER_BUDGET).toContain('settledKopecks')
        // A missing period is a fact to show, not a zero budget to act on, and
        // a ledger that stopped matching its applications is shown, not fixed.
        expect(MANAGER_BUDGET).toContain("'missing'")
        expect(MANAGER_BUDGET).toContain('ledgerConsistent')
    })

    it('filters on the same words the service knows', () => {
        for (const field of ['periodKey', 'state', 'externalParkId']) {
            expect(MANAGER_FILTERS).toContain(field)
        }
        expect(MANAGER_BOARD).toContain('managerBoard')
    })

    it('re-reads the state after every action rather than moving the screen itself', () => {
        expect(MANAGER_ACTIONS).toContain("revalidatePath('/compensation')")
        expect(MANAGER_ACTIONS).toContain('revalidatePath(`/compensation/${input.applicationId}`)')
        // The component shows the service's own answer; it never assumes one.
        expect(MANAGER_DETAIL).toContain('RESULT_TEXT[result.code]')
        expect(MANAGER_DETAIL).not.toMatch(/setState\(\s*'(paid|rejected|awaiting_payment)'/)
    })
})
