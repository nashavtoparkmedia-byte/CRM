import type {
  ShadowComparisonResultRecord,
  ShadowComparisonRunRecord,
  ShadowReadinessSummary,
  ShadowSemanticDiffRecord,
} from './types.ts'

export function buildShadowReadinessSummary(
  run: ShadowComparisonRunRecord,
  results: readonly ShadowComparisonResultRecord[],
  diffs: readonly ShadowSemanticDiffRecord[],
  fixtureCoverage: number,
  deterministicReplay: number,
): ShadowReadinessSummary {
  const total = run.processedCount
  const criticalRegressions = results.filter(result => result.classification === 'regression'
    && result.highestSeverity === 'critical').length
  const providerIdentity = diffs.filter(diff => diff.severity === 'critical'
    && /providerMessageId|providerUserId|protocolChatId/.test(diff.path)).length
  const routeCritical = diffs.filter(diff => diff.severity === 'critical'
    && /protocolChatId|providerUserId|routeEvidence/.test(diff.path)).length
  const replyReaction = diffs.filter(diff => diff.differenceKind === 'reply_target_mismatch'
    || diff.differenceKind === 'reaction_target_mismatch').length
  const media = diffs.filter(diff => diff.differenceKind === 'attachment_count_mismatch'
    || diff.differenceKind === 'attachment_identity_mismatch'
    || diff.differenceKind === 'media_kind_mismatch'
    || diff.differenceKind === 'caption_hash_mismatch').length
  const explained = run.matchedCount + run.expectedDifferenceCount + run.unsupportedCount + run.quarantinedCount
  return {
    totalObservations: total,
    matched: run.matchedCount,
    expectedDifferences: run.expectedDifferenceCount,
    regressions: run.regressionCount,
    criticalRegressions,
    unsupported: run.unsupportedCount,
    quarantined: run.quarantinedCount,
    legacyOnly: run.legacyOnlyCount,
    newOnly: run.newOnlyCount,
    comparisonCoverage: total === 0 ? 0 : explained / total,
    fixtureCoverage,
    routeCriticalMismatchCount: routeCritical,
    providerIdentityMismatchCount: providerIdentity,
    replyReactionTargetMismatchCount: replyReaction,
    mediaMismatchCount: media,
    deterministicReplay,
    stage8Ready: total > 0 && criticalRegressions === 0 && routeCritical === 0
      && providerIdentity === 0 && deterministicReplay === 1 && fixtureCoverage === 1,
  }
}
