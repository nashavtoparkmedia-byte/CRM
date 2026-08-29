import type { OpaqueCredentialRefV1 } from '../../../contracts/calling/v1'

const credentialValues = new WeakMap<OpaqueCredentialRefV1, string>()

/** Captures a provider credential without placing its value in a command object. */
export function captureAiAgentProviderCredentialV1(value: string): OpaqueCredentialRefV1 {
  if (typeof value !== 'string') throw new Error('Provider credential must be a string')
  const reference = Object.freeze({}) as OpaqueCredentialRefV1
  credentialValues.set(reference, value)
  return reference
}

/** Consumes a credential reference at the persistence boundary. */
export function revealAiAgentProviderCredentialV1(reference: OpaqueCredentialRefV1): string {
  if (!credentialValues.has(reference)) {
    throw new Error('Invalid provider credential reference')
  }
  const value = credentialValues.get(reference) as string
  credentialValues.delete(reference)
  return value
}
