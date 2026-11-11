'use server'

import type { ManualCallAvailabilityResultV1 } from '@/contracts/calling/v1/manual-call'
import { readManualCallAvailability } from '../../application/manual-call-runtime'

/**
 * Whether the signed-in employee may call this Contact now, and which of its phones.
 * The browser only shows or hides the call action; every decision is made on the server
 * and is made again when the call is started.
 */
export async function manualCallAvailabilityActionV1(input: unknown): Promise<ManualCallAvailabilityResultV1> {
  return readManualCallAvailability(input)
}
