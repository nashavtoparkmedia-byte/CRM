import { DispatchLedgerError } from './errors.ts'
import type { SenderAuthorityInput, SenderAuthorityProof, SenderAuthorityVerifier } from './types.ts'

export class FailClosedSenderAuthorityVerifier implements SenderAuthorityVerifier {
  async verify(_input: SenderAuthorityInput): Promise<SenderAuthorityProof> {
    throw new DispatchLedgerError('SENDER_AUTHORITY_REQUIRED', 'Sender authority is unavailable')
  }
}

export function validateSenderAuthorityProof(
  input: SenderAuthorityInput,
  proof: SenderAuthorityProof,
): SenderAuthorityProof {
  if (proof.accountId !== input.accountId || proof.ownerId !== input.ownerId
    || proof.fencingEpoch !== input.fencingEpoch || proof.verifiedAt.valueOf() !== input.proofTimestamp.valueOf()
    || proof.leaseUntil <= input.now) {
    throw new DispatchLedgerError('STALE_SENDER_AUTHORITY', 'Sender authority proof is stale or account-mismatched')
  }
  return proof
}
