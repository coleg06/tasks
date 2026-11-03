export function eventArchiveVisibilityClause(stage: string) {
  if (!stage) return null;
  return stage === 'archived' ? 'e.archived_at IS NOT NULL' : 'e.archived_at IS NULL';
}
