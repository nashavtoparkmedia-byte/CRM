import type { JsonValue } from '../journal/types.ts'

export interface ProviderAbsenceEvidenceInput {
  readonly accountId: string
  readonly normalizedEventId: string
  readonly dispatchId: string
  readonly attemptId: string
  readonly absenceReference: string
  readonly verifierInput: JsonValue
  readonly expectedStateVersion: number
  readonly expectedAttemptVersion: number
  readonly now?: Date
}
export interface VerifiedProviderAbsenceEvidence {
  readonly accountId: string
  readonly dispatchId: string
  readonly attemptId: string
  readonly absenceReference: string
  readonly verifierVersion: string
  readonly verifiedAt: Date
}

export interface ProviderAbsenceEvidenceVerifier {
  verify(input: ProviderAbsenceEvidenceInput): Promise<VerifiedProviderAbsenceEvidence | null>
}

export class DenyAllProviderAbsenceEvidenceVerifier implements ProviderAbsenceEvidenceVerifier {
  async verify(_input: ProviderAbsenceEvidenceInput): Promise<null> {
    return null
  }
}
