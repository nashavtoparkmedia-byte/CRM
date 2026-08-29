export const FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1 = 'fleet_operations.FindDriverByExactPhoneQuery.v1' as const
export const FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1 = 'fleet_operations.FindDriverByExactPhoneResult.v1' as const

export interface FindDriverByExactPhoneQueryV1 {
  contract: typeof FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1
  phone: string
}

export interface FindDriverByExactPhoneResultV1 {
  contract: typeof FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1
  driverId: string | null
}

export class FindDriverByExactPhoneQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(
    code: FindDriverByExactPhoneQueryValidationError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'FindDriverByExactPhoneQueryValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new FindDriverByExactPhoneQueryValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFindDriverByExactPhoneQueryV1(
  input: unknown,
): FindDriverByExactPhoneQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')

  const supportedFields = ['contract', 'phone']
  const extraFields = Object.keys(input).filter((key) => !supportedFields.includes(key))
  if (extraFields.length > 0) {
    invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  }

  if (input.contract !== FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1) {
    if (
      typeof input.contract === 'string'
      && input.contract.startsWith('fleet_operations.FindDriverByExactPhoneQuery.')
    ) {
      throw new FindDriverByExactPhoneQueryValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1}`)
  }

  if (typeof input.phone !== 'string' || input.phone.trim() === '') {
    invalid('phone is required')
  }

  return input as unknown as FindDriverByExactPhoneQueryV1
}
