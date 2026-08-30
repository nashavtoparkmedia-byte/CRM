export const GET_DRIVER_CALLABLE_PHONE_QUERY_V1 = 'fleet_operations.GetDriverCallablePhoneQuery.v1' as const
export const GET_DRIVER_CALLABLE_PHONE_RESULT_V1 = 'fleet_operations.GetDriverCallablePhoneResult.v1' as const

export interface GetDriverCallablePhoneQueryV1 {
  contract: typeof GET_DRIVER_CALLABLE_PHONE_QUERY_V1
  driverId: string
}

export type GetDriverCallablePhoneResultV1 =
  | {
      contract: typeof GET_DRIVER_CALLABLE_PHONE_RESULT_V1
      status: 'resolved'
      driverId: string
      phone: string
    }
  | {
      contract: typeof GET_DRIVER_CALLABLE_PHONE_RESULT_V1
      status: 'not_found' | 'no_callable_phone'
      driverId: string
    }

export class GetDriverCallablePhoneQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(
    code: GetDriverCallablePhoneQueryValidationError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'GetDriverCallablePhoneQueryValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new GetDriverCallablePhoneQueryValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseGetDriverCallablePhoneQueryV1(
  input: unknown,
): GetDriverCallablePhoneQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')

  const supportedFields = ['contract', 'driverId']
  const extraFields = Object.keys(input).filter((key) => !supportedFields.includes(key))
  if (extraFields.length > 0) {
    invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  }

  if (input.contract !== GET_DRIVER_CALLABLE_PHONE_QUERY_V1) {
    if (
      typeof input.contract === 'string'
      && input.contract.startsWith('fleet_operations.GetDriverCallablePhoneQuery.')
    ) {
      throw new GetDriverCallablePhoneQueryValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${GET_DRIVER_CALLABLE_PHONE_QUERY_V1}`)
  }

  if (typeof input.driverId !== 'string' || input.driverId.trim() === '') {
    invalid('driverId is required')
  }

  return input as unknown as GetDriverCallablePhoneQueryV1
}
