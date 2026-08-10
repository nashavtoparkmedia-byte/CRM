const forbiddenWildcard = value => typeof value === 'string' && /(?:^|[/.*])\*{1,2}(?:$|[/.*])/u.test(value)

export function validateCapabilityRegistry(registry) {
  const failures = []
  const ids = new Set()
  for (const row of registry.capabilities ?? []) {
    if (!row.capability_id || ids.has(row.capability_id)) failures.push(`duplicate or missing capability id: ${row.capability_id ?? '<missing>'}`)
    ids.add(row.capability_id)
    const exactValues = [row.source?.path, ...(row.source?.site_signatures ?? []), ...(row.target?.exact_names ?? []), ...(row.target?.operations ?? [])]
    if (exactValues.some(forbiddenWildcard)) failures.push(`${row.capability_id}: wildcard scope is forbidden`)
    if (row.approved && row.status !== 'APPROVED') failures.push(`${row.capability_id}: approved flag requires APPROVED status`)
    if (row.approved && (!row.source?.site_signatures?.length || !row.target?.exact_names?.length || !row.target?.operations?.length)) failures.push(`${row.capability_id}: approved capability lacks exact site/target/operation`)
  }
  return failures
}

export function authorizeMaintenanceWrite(registry, write) {
  return (registry.capabilities ?? []).some(row => row.approved === true
    && row.status === 'APPROVED'
    && row.source.path === write.source_path
    && row.source.site_signatures.includes(write.site_signature)
    && row.target.data_owner === write.data_owner
    && row.target.exact_names.includes(write.target)
    && row.target.operations.includes(write.operation))
}
