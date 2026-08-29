import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
  GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
  GetDriverCallablePhoneQueryValidationError,
} from '@/contracts/fleet-operations/v1'
import { createGetDriverCallablePhoneHandlerV1 } from './get-driver-callable-phone-handler'

describe('Fleet GetDriverCallablePhoneQuery.v1 owner boundary', () => {
  it('returns only the stable Driver reference and owner-selected callable phone', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'driver-1', phone: '8 (999) 000-00-00' })
    const query = createGetDriverCallablePhoneHandlerV1({ findById })

    await expect(query({
      contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
      driverId: 'driver-1',
    })).resolves.toEqual({
      contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
      status: 'resolved',
      driverId: 'driver-1',
      phone: '8 (999) 000-00-00',
    })
    expect(findById).toHaveBeenCalledWith('driver-1')
  })

  it('returns an explicit not-found state', async () => {
    const query = createGetDriverCallablePhoneHandlerV1({
      findById: vi.fn().mockResolvedValue(null),
    })
    await expect(query({
      contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
      driverId: 'missing-driver',
    })).resolves.toEqual({
      contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
      status: 'not_found',
      driverId: 'missing-driver',
    })
  })

  it.each([null, '', '   '])('returns no-callable-phone for owner value %j', async (phone) => {
    const query = createGetDriverCallablePhoneHandlerV1({
      findById: vi.fn().mockResolvedValue({ id: 'driver-1', phone }),
    })
    await expect(query({
      contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
      driverId: 'driver-1',
    })).resolves.toEqual({
      contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
      status: 'no_callable_phone',
      driverId: 'driver-1',
    })
  })

  it.each([null, {}, [], '', 12])('rejects invalid Driver references %j before persistence', async (driverId) => {
    const findById = vi.fn()
    const query = createGetDriverCallablePhoneHandlerV1({ findById })
    await expect(query({
      contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
      driverId,
    })).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
    expect(findById).not.toHaveBeenCalled()
  })

  it('rejects unknown fields and later contract versions fail closed', async () => {
    const findById = vi.fn()
    const query = createGetDriverCallablePhoneHandlerV1({ findById })
    await expect(query({
      contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
      driverId: 'driver-1',
      include: 'everything',
    })).rejects.toBeInstanceOf(GetDriverCallablePhoneQueryValidationError)
    await expect(query({
      contract: 'fleet_operations.GetDriverCallablePhoneQuery.v2',
      driverId: 'driver-1',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
    expect(findById).not.toHaveBeenCalled()
  })

  it('leaves owner adapter failures visible', async () => {
    const query = createGetDriverCallablePhoneHandlerV1({
      findById: vi.fn().mockRejectedValue(new Error('fleet storage unavailable')),
    })
    await expect(query({
      contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
      driverId: 'driver-1',
    })).rejects.toThrow('fleet storage unavailable')
  })

  it('keeps the legacy persistence projection limited to the public result needs', () => {
    const adapter = readFileSync(join(
      process.cwd(),
      'src/modules/fleet-operations/public/v1/legacy-prisma-get-driver-callable-phone-adapter.ts',
    ), 'utf8')
    expect(adapter).toContain('select: { id: true, phone: true }')
    expect(adapter).not.toMatch(/select:\s*undefined|include:/)
  })
})
