import {
  FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1,
  parseFindDriverByExactPhoneQueryV1,
  type FindDriverByExactPhoneQueryV1,
  type FindDriverByExactPhoneResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface FindDriverByExactPhonePersistencePortV1 {
  findByExactPhone(phone: string): Promise<{ id: string } | null>
}

export function createFindDriverByExactPhoneHandlerV1(
  port: FindDriverByExactPhonePersistencePortV1,
) {
  return async function findDriverByExactPhoneV1(
    query: FindDriverByExactPhoneQueryV1 | unknown,
  ): Promise<FindDriverByExactPhoneResultV1> {
    const parsed = parseFindDriverByExactPhoneQueryV1(query)
    const driver = await port.findByExactPhone(parsed.phone)
    return {
      contract: FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1,
      driverId: driver?.id ?? null,
    }
  }
}
