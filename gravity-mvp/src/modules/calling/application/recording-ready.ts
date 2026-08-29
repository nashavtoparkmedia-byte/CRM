import type { PersistRecordingReadyV1 } from '../public/v1/recording-ready-operation'
import { persistRecordingReadyV1 as persistRecordingReadyWithPrismaV1 } from '../internal/recording-ready-prisma-adapter'

/**
 * Owner-composed, ready-to-use Calling operation. Consumers receive only the
 * business function; the Prisma transaction capability stays behind the
 * internal adapter boundary.
 */
export const persistRecordingReadyV1: PersistRecordingReadyV1 = (input) => (
    persistRecordingReadyWithPrismaV1(input)
)
