export type ExactMaxSenderCandidate = { id: string }

export type ExactMaxSenderSelection<T extends ExactMaxSenderCandidate> =
  | { status: 'no_match'; candidateCount: 0 }
  | { status: 'reuse'; candidateCount: 1; candidate: T }
  | { status: 'ambiguous'; candidateCount: number; candidateIds: string[] }

/** Selects only a unique exact sender mapping. Candidate ordering is irrelevant. */
export function selectUniqueExactMaxSenderCandidate<T extends ExactMaxSenderCandidate>(
  candidates: readonly T[],
): ExactMaxSenderSelection<T> {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const unique = [...byId.values()]
  if (unique.length === 0) return { status: 'no_match', candidateCount: 0 }
  if (unique.length === 1) return { status: 'reuse', candidateCount: 1, candidate: unique[0] }
  return {
    status: 'ambiguous',
    candidateCount: unique.length,
    candidateIds: unique.map(candidate => candidate.id).sort((a, b) => a.localeCompare(b)),
  }
}
