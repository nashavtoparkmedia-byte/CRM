'use server'

// Compatibility path for legacy root-page consumers. Fleet owns the implementation.
export {
  addApiConnection,
  changeDriverLimit,
  deleteApiConnection,
  getApiConnections,
  getApiLogs,
  getCarById,
  getDriverById,
  getDrivers,
  testApiRequest,
  updateApiConnectionName,
} from '@/modules/fleet-operations/public/v1/yandex-fleet-operations'
export type {
  Car,
  Driver,
  DriverStatus,
} from '@/modules/fleet-operations/public/v1/yandex-fleet-operations'
