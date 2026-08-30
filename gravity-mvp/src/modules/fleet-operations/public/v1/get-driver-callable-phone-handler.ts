import {
  GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
  parseGetDriverCallablePhoneQueryV1,
  type GetDriverCallablePhoneQueryV1,
  type GetDriverCallablePhoneResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface GetDriverCallablePhonePersistencePortV1 {
  findById(driverId: string): Promise<{ id: string; phone: string | null } | null>
}

export function createGetDriverCallablePhoneHandlerV1(
  port: GetDriverCallablePhonePersistencePortV1,
) {
  return async function getDriverCallablePhoneV1(
    query: GetDriverCallablePhoneQueryV1 | unknown,
  ): Promise<GetDriverCallablePhoneResultV1> {
    const parsed = parseGetDriverCallablePhoneQueryV1(query)
    const driver = await port.findById(parsed.driverId)
    if (!driver) {
      return {
        contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
        status: 'not_found',
        driverId: parsed.driverId,
      }
    }
    if (typeof driver.phone !== 'string' || driver.phone.trim() === '') {
      return {
        contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
        status: 'no_callable_phone',
        driverId: driver.id,
      }
    }
    return {
      contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
      status: 'resolved',
      driverId: driver.id,
      phone: driver.phone,
    }
  }
}
