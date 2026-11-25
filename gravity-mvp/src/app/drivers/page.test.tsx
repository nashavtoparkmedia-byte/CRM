import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationAdminAuthorizationError } from '@/modules/identity-access/public/v1'

const mocks = vi.hoisted(() => ({
  getDriversWithCells: vi.fn(),
  listOperationalTelegramConnectionsV1: vi.fn(),
}))

vi.mock('./actions', () => ({ getDriversWithCells: mocks.getDriversWithCells }))
vi.mock('@/infrastructure/telegram/operational-capabilities', () => ({
  listOperationalTelegramConnectionsV1: mocks.listOperationalTelegramConnectionsV1,
}))
vi.mock('./DriversClient', () => ({ default: (props: { telegramConnections: unknown[] }) => <div data-testid="connections">{JSON.stringify(props.telegramConnections)}</div> }))
vi.mock('@/infrastructure/ui/SectionDescription', () => ({ SectionDescription: () => null }))
vi.mock('@/infrastructure/ui/PageContainer', () => ({ PageContainer: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import DriversPage from './page'

describe('DriversPage integration-admin metadata', () => {
  beforeEach(() => {
    mocks.getDriversWithCells.mockResolvedValue({ drivers: [], total: 0, segmentCounts: {} })
    mocks.listOperationalTelegramConnectionsV1.mockReset()
  })

  it('renders the driver list when integration-admin session is absent', async () => {
    mocks.listOperationalTelegramConnectionsV1.mockRejectedValue(new IntegrationAdminAuthorizationError())
    const page = await DriversPage({ searchParams: Promise.resolve({}) })
    expect(page).toBeTruthy()
    expect(JSON.stringify(page)).toContain('[]')
  })

  it('does not hide unexpected connection lookup failures', async () => {
    const error = new Error('database unavailable')
    mocks.listOperationalTelegramConnectionsV1.mockRejectedValue(error)
    await expect(DriversPage({ searchParams: Promise.resolve({}) })).rejects.toBe(error)
  })
})
