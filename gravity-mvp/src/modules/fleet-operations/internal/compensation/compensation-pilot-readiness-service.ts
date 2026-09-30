/**
 * The seam the readiness proof is composed through.
 *
 * It reads and decides; it never writes, never asks a provider anything and
 * never changes a mode. Every rule it applies belongs to compensation-pilot-
 * readiness, and every fact it reads belongs to an owner that already published
 * the read: the pilot port for orders, claims, budget and Contacts, cash-order
 * ingestion for park scope, authority and catalogue, and the Telegram link
 * reader Fleet declares but does not implement.
 *
 * The order of work is deliberate. The population is narrowed by facts the
 * Driver row already carries before any other owner is asked about anyone, so a
 * park with thousands of drivers costs one query, and a driver who could never
 * be served is never looked up in Contacts or in the Telegram link table.
 */

import {
    pilotCandidateFactsGateV1,
    pilotCandidateGateV1,
    pilotInputGateV1,
    type PilotCandidateDriverV1,
    type PilotCandidateRefusalV1,
    type PilotCandidateV1,
    type PilotInputCountsV1,
    type PilotInputRefusalV1,
} from './compensation-pilot-readiness'
import {
    type PilotCatalogueFactsV1,
    type PilotCatalogueStatusV1,
} from './compensation-pilot-selection'
import { pilotCatalogueStatusV1 } from './compensation-pilot-selection'
import type { CompensationPilotPortV1 } from './compensation-pilot-service'
import type { CompensationPilotTelegramLinkReaderV1 } from '../../public/v1/compensation-pilot-telegram-link-reader'

/** At most this many in-scope Driver rows are examined in one run. */
export const PILOT_READINESS_POPULATION_LIMIT_V1 = 5000
/** At most this many candidate rows are reported; the counts always cover all. */
export const PILOT_READINESS_CANDIDATE_REPORT_LIMIT_V1 = 50
/** Telegram links are asked for in batches this size, well inside its own cap. */
export const PILOT_READINESS_TELEGRAM_BATCH_V1 = 100

/** The smallest Driver enumeration readiness needs. */
export interface CompensationPilotReadinessPopulationPortV1 {
    listPilotCandidateDrivers(input: {
        externalParkIds: readonly string[]
        limit: number
    }): Promise<PilotCandidateDriverV1[]>
}

/** What cash-order ingestion is asked, all of it local and read-only. */
export interface CompensationPilotReadinessIngestionPortV1 {
    /** The configured pilot scope: the one authority for which parks are in it. */
    parkScope(): { mode: string; enabledParks: readonly string[]; configError: string | null }
    readParkAuthority(externalParkId: string): Promise<{ status: 'authoritative' | 'failed'; code: string | null }>
    readCatalogueFacts(externalParkId: string): Promise<PilotCatalogueFactsV1>
}

export interface PilotReadinessParkV1 {
    externalParkId: string
    parkAuthority: 'authoritative' | 'failed'
    /** The authority classifier's own code when it refused; null when authoritative. */
    parkAuthorityCode: string | null
    catalogueStatus: PilotCatalogueStatusV1
}

export interface PilotReadinessCandidateV1 {
    driverId: string
    externalParkId: string
    firstMonthKey: string
    pilotCandidateReady: boolean
    pilotInputReady: boolean
    catalogueStatus: PilotCatalogueStatusV1 | null
    counts: PilotInputCountsV1 | null
    /** Bounded codes only, in the order the gates refused. */
    reasons: readonly string[]
}

export interface PilotReadinessCountsV1 {
    pilotParkDrivers: number
    populationTruncated: boolean
    /** Sync-population diagnostics: how many in-scope drivers carry each fact. */
    withExternalDriverProfileId: number
    withSelfEmployedTrue: number
    withSelfEmployedUnknown: number
    withHireDate: number
    factsGatePassed: number
    candidateReady: number
    inputReady: number
    candidatesReported: number
    candidatesTruncated: boolean
}

/** Why a readiness verdict is not a complete proof. */
export const PILOT_READINESS_PROOF_GAPS_V1 = ['population_truncated_proof_incomplete'] as const
export type PilotReadinessProofGapV1 = typeof PILOT_READINESS_PROOF_GAPS_V1[number]

export interface PilotReadinessReportV1 {
    generatedAt: Date
    /** Ingestion mode as the runtime resolved it, never the raw environment. */
    mode: string
    configError: string | null
    pilotParks: readonly string[]
    /**
     * No authoritative persisted marker for a completed Yandex fleet sync exists
     * in this repository, so readiness never claims one. The facts below are the
     * evidence; proving the sync ran is a release-procedure step outside this read.
     */
    syncEvidence: 'not_persisted'
    pilotCandidateReady: boolean
    pilotInputReady: boolean
    /**
     * Whether a `false` above is a proven negative over the whole population.
     *
     * Readiness is existential, so one qualifying driver proves `true` however
     * much of the population was examined. A `false` proves nothing unless the
     * whole population was examined, and the population read is bounded. So a
     * truncated scan that found nothing reports not-proven rather than false,
     * and an operator is never shown an unknown dressed as a complete negative.
     */
    pilotCandidateProofComplete: boolean
    pilotInputProofComplete: boolean
    /** Set only while a gate above is unproven; a bounded code, never prose. */
    proofIncompleteReason: PilotReadinessProofGapV1 | null
    counts: PilotReadinessCountsV1
    parks: readonly PilotReadinessParkV1[]
    candidates: readonly PilotReadinessCandidateV1[]
    reasons: readonly { gate: 'candidate' | 'input'; code: string; count: number }[]
}

function chunk<T>(values: readonly T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size))
    }
    return chunks
}

/**
 * The whole proof, for every park currently in the pilot scope.
 *
 * A configuration fault disables every park, so the scope is empty and the
 * report says so rather than reading a population nothing could serve.
 */
export async function compensationPilotReadinessReportV1(
    pilot: CompensationPilotPortV1,
    population: CompensationPilotReadinessPopulationPortV1,
    ingestion: CompensationPilotReadinessIngestionPortV1,
    readTelegramLinks: CompensationPilotTelegramLinkReaderV1,
    now: Date,
): Promise<PilotReadinessReportV1> {
    const scope = ingestion.parkScope()
    const pilotParks = scope.configError === null ? [...scope.enabledParks] : []

    const candidateRefusals = new Map<PilotCandidateRefusalV1, number>()
    const inputRefusals = new Map<PilotInputRefusalV1, number>()
    const countRefusal = <T>(counter: Map<T, number>, code: T) =>
        counter.set(code, (counter.get(code) ?? 0) + 1)

    const drivers = pilotParks.length === 0
        ? []
        : await population.listPilotCandidateDrivers({
            externalParkIds: pilotParks,
            limit: PILOT_READINESS_POPULATION_LIMIT_V1,
        })

    const counts: PilotReadinessCountsV1 = {
        pilotParkDrivers: drivers.length,
        populationTruncated: drivers.length >= PILOT_READINESS_POPULATION_LIMIT_V1,
        withExternalDriverProfileId: 0,
        withSelfEmployedTrue: 0,
        withSelfEmployedUnknown: 0,
        withHireDate: 0,
        factsGatePassed: 0,
        candidateReady: 0,
        inputReady: 0,
        candidatesReported: 0,
        candidatesTruncated: false,
    }

    const prescreened: Extract<ReturnType<typeof pilotCandidateFactsGateV1>, { passed: true }>[] = []
    for (const driver of drivers) {
        if (driver.externalDriverProfileId !== null && driver.externalDriverProfileId.trim() !== '') {
            counts.withExternalDriverProfileId += 1
        }
        if (driver.facts.isSelfEmployed === true) counts.withSelfEmployedTrue += 1
        if (driver.facts.isSelfEmployed === null || driver.facts.isSelfEmployed === undefined) {
            counts.withSelfEmployedUnknown += 1
        }
        if (driver.facts.parkHireDate !== null) counts.withHireDate += 1

        const gate = pilotCandidateFactsGateV1(driver, pilotParks, now)
        if (gate.passed) prescreened.push(gate)
        else countRefusal(candidateRefusals, gate.reason)
    }
    counts.factsGatePassed = prescreened.length

    // One batched Telegram read for the prescreened drivers only, and a driver
    // absent from the answer simply has no link.
    const links = new Map<string, { activeParkId: string | null }>()
    for (const batch of chunk(prescreened.map((entry) => entry.driverId), PILOT_READINESS_TELEGRAM_BATCH_V1)) {
        for (const link of await readTelegramLinks(batch)) {
            links.set(link.driverId, { activeParkId: link.activeParkId })
        }
    }

    const rows: PilotReadinessCandidateV1[] = []
    const ready: PilotCandidateV1[] = []
    for (const entry of prescreened) {
        const gate = pilotCandidateGateV1(entry, {
            telegramLink: links.get(entry.driverId) ?? null,
            mainDriverConfirmation: await pilot.confirmMainDriver(entry.contactId, entry.driverId),
            lineage: await pilot.resolveContactLineage(entry.contactId),
        })
        if (!gate.ready) {
            countRefusal(candidateRefusals, gate.reason)
            rows.push({
                driverId: entry.driverId,
                externalParkId: entry.externalParkId,
                firstMonthKey: entry.firstMonthKey,
                pilotCandidateReady: false,
                pilotInputReady: false,
                catalogueStatus: null,
                counts: null,
                reasons: [gate.reason],
            })
            continue
        }
        ready.push(gate.candidate)
    }
    counts.candidateReady = ready.length

    // Park-level facts are read once per park, not once per candidate.
    const parks = new Map<string, PilotReadinessParkV1>()
    const catalogueFacts = new Map<string, PilotCatalogueFactsV1>()
    for (const externalParkId of [...new Set(ready.map((candidate) => candidate.externalParkId))]) {
        const authority = await ingestion.readParkAuthority(externalParkId)
        const facts = await ingestion.readCatalogueFacts(externalParkId)
        catalogueFacts.set(externalParkId, facts)
        parks.set(externalParkId, {
            externalParkId,
            parkAuthority: authority.status,
            parkAuthorityCode: authority.status === 'authoritative' ? null : authority.code,
            catalogueStatus: pilotCatalogueStatusV1(facts),
        })
    }

    for (const candidate of ready) {
        const park = parks.get(candidate.externalParkId)!
        const facts = catalogueFacts.get(candidate.externalParkId)!
        const gate = pilotInputGateV1(candidate, {
            parkAuthority: park.parkAuthority,
            catalogueStatus: park.catalogueStatus,
            dbNow: facts.dbNow,
            orders: await pilot.findCashOrders({
                externalParkId: candidate.externalParkId,
                externalDriverProfileId: candidate.externalDriverProfileId,
            }),
            claimedOrderIds: await pilot.findClaimedOrderIds(candidate.lineage),
            budgetPeriod: await pilot.findBudgetPeriod(candidate.firstMonthKey),
        }, now)
        if (!gate.ready) countRefusal(inputRefusals, gate.reason)
        else counts.inputReady += 1
        rows.push({
            driverId: candidate.driverId,
            externalParkId: candidate.externalParkId,
            firstMonthKey: candidate.firstMonthKey,
            pilotCandidateReady: true,
            pilotInputReady: gate.ready,
            catalogueStatus: park.catalogueStatus,
            counts: gate.counts,
            reasons: gate.ready ? [] : [gate.reason],
        })
    }

    // Ready candidates first, so a truncated list always shows the ones that
    // matter; the counts above are never truncated.
    const ordered = rows.slice().sort((left, right) => (
        Number(right.pilotInputReady) - Number(left.pilotInputReady)
        || Number(right.pilotCandidateReady) - Number(left.pilotCandidateReady)
        || left.driverId.localeCompare(right.driverId)
    ))
    counts.candidatesTruncated = ordered.length > PILOT_READINESS_CANDIDATE_REPORT_LIMIT_V1
    const reported = ordered.slice(0, PILOT_READINESS_CANDIDATE_REPORT_LIMIT_V1)
    counts.candidatesReported = reported.length

    const reasons = [
        ...[...candidateRefusals.entries()].map(([code, count]) => ({ gate: 'candidate' as const, code, count })),
        ...[...inputRefusals.entries()].map(([code, count]) => ({ gate: 'input' as const, code, count })),
    ].sort((left, right) => left.gate.localeCompare(right.gate) || left.code.localeCompare(right.code))

    // Existential: a hit proves the gate whatever was truncated; a miss proves
    // it only over a population that was read whole.
    const pilotCandidateReady = counts.candidateReady > 0
    const pilotInputReady = counts.inputReady > 0
    const pilotCandidateProofComplete = pilotCandidateReady || !counts.populationTruncated
    const pilotInputProofComplete = pilotInputReady || !counts.populationTruncated

    return {
        generatedAt: now,
        mode: scope.mode,
        configError: scope.configError,
        pilotParks,
        syncEvidence: 'not_persisted',
        pilotCandidateReady,
        pilotInputReady,
        pilotCandidateProofComplete,
        pilotInputProofComplete,
        proofIncompleteReason: pilotCandidateProofComplete && pilotInputProofComplete
            ? null
            : 'population_truncated_proof_incomplete',
        counts,
        parks: [...parks.values()].sort((left, right) => left.externalParkId.localeCompare(right.externalParkId)),
        candidates: reported,
        reasons,
    }
}
