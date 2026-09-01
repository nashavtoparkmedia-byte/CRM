"use client"

import { useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'

type Profile = {
  driverId: string
  externalParkId: string
  externalDriverProfileId: string
  fullName: string
  phones: string[]
  normalizedVu: string | null
  rawVu?: string | null
  legalRole?: string | null
  status?: string | null
  city?: string | null
  profileType?: string | null
  sourceFreshness: 'fresh' | 'stale' | 'unknown'
  evidenceRoot: string
}

type Cluster = {
  profileClusterKey: string
  profiles: Profile[]
  warnings: string[]
}

function basisFor(query: string): 'fio' | 'phone' | 'vu' {
  const compact = query.replace(/[\s()+-]/g, '')
  if (/^\d{10,15}$/.test(compact)) return 'phone'
  if (/\d/.test(compact) && !/\s/.test(query.trim())) return 'vu'
  return 'fio'
}

export default function DriverPersonSearchModal({
  contactId,
  isOpen,
  onClose,
  onConfirmed,
}: {
  contactId: string
  isOpen: boolean
  onClose: () => void
  onConfirmed: () => void
}) {
  const [query, setQuery] = useState('')
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!isOpen) return null

  const search = async () => {
    if (query.trim().length < 3) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/monitoring/fleet-check/driver-person?query=${encodeURIComponent(query)}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Поиск не выполнен')
      setClusters(body.clusters || [])
      if (body.errors?.length) setError(`Часть парков недоступна: ${body.errors.length}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Поиск не выполнен')
    } finally {
      setLoading(false)
    }
  }

  const confirm = async (cluster: Cluster) => {
    setConfirming(cluster.profileClusterKey)
    setError(null)
    try {
      const representative = cluster.profiles[0]
      const response = await fetch(`/api/contacts/${contactId}/driver-person`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileClusterKey: cluster.profileClusterKey,
          representativeDriverId: representative.driverId,
          confirmationBasis: basisFor(query),
          searchInput: query,
          profiles: cluster.profiles,
          warnings: cluster.warnings,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || body.confirmation?.status || 'Подтверждение не сохранено')
      const followup = await fetch('/api/monitoring/fleet-check/driver-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      if (!followup.ok) {
        throw new Error('Подтверждение сохранено, но обновление парков не выполнено. Повторите проверку парков.')
      }
      onConfirmed()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Подтверждение не сохранено')
    } finally {
      setConfirming(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center bg-black/40 pt-[8vh]" onClick={onClose}>
      <div className="flex max-h-[82vh] w-[680px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h3 className="font-semibold">Найти водителя в парках</h3>
            <p className="text-[11px] text-gray-500">Поиск по ФИО, телефону или ВУ во всех включённых парках</p>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="flex gap-2 border-b p-4">
          <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === 'Enter' && search()} placeholder="ФИО, телефон или ВУ" className="h-9 flex-1 rounded-lg bg-gray-100 px-3 text-sm outline-none" />
          <button onClick={search} disabled={loading || query.trim().length < 3} className="flex h-9 items-center gap-1 rounded-lg bg-[#3390EC] px-4 text-sm font-semibold text-white disabled:opacity-40">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Найти
          </button>
        </div>
        {error && <div className="mx-4 mt-3 rounded bg-amber-50 p-2 text-xs text-amber-800">{error}</div>}
        <div className="overflow-y-auto p-4">
          {clusters.map(cluster => (
            <div key={cluster.profileClusterKey} className="mb-3 rounded-lg border p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold">{cluster.profiles[0]?.fullName || 'Без имени'} · {cluster.profiles.length} проф.</div>
                <button onClick={() => confirm(cluster)} disabled={Boolean(confirming)} className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {confirming === cluster.profileClusterKey ? 'Сохраняем…' : 'Это он'}
                </button>
              </div>
              {cluster.warnings.length > 0 && <div className="mb-2 text-[10px] text-amber-700">{cluster.warnings.join(' · ')}</div>}
              <div className="space-y-1">
                {cluster.profiles.map(profile => (
                  <div key={profile.driverId} className="grid grid-cols-[1fr_1fr_1fr] gap-2 rounded bg-gray-50 p-2 text-[10px]">
                    <span>{profile.externalParkId}<br />{profile.legalRole || profile.profileType || 'роль —'}</span>
                    <span>{profile.phones.join(', ') || 'телефон —'}<br />ВУ {profile.rawVu || profile.normalizedVu || '—'}</span>
                    <span>{profile.status || 'статус —'}<br />{profile.city || 'город —'} · {profile.sourceFreshness}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!loading && clusters.length === 0 && <div className="py-10 text-center text-sm text-gray-400">Введите данные для поиска</div>}
        </div>
      </div>
    </div>
  )
}
