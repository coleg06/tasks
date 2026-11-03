/**
 * Who may see which audit events. Task managers (`tasks.manage`) administer people and shared
 * work, but a personal project is private to its owner: they cannot read its tasks, so the audit
 * log must not show those tasks' or their comments' content either. Only platform administrators
 * see every event.
 *
 * Both fragments take the SQL alias of `audit_events` and use no bind parameters.
 */

/** True for audit events about a task, comment, project or membership of a personal project. */
export function personalContentSql(alias = 'ae') {
  return `(
    (${alias}.entity_type = 'task' AND EXISTS (
      SELECT 1 FROM tasks vt JOIN projects vp ON vp.id = vt.project_id
      WHERE vt.task_key = ${alias}.entity_key AND vp.project_type = 'personal'))
    OR (${alias}.entity_type = 'comment' AND EXISTS (
      SELECT 1 FROM task_comments vc
      JOIN tasks vt ON vt.id = vc.task_id JOIN projects vp ON vp.id = vt.project_id
      WHERE vc.id = CAST(${alias}.entity_key AS INTEGER) AND vp.project_type = 'personal'))
    OR (${alias}.entity_type = 'project' AND EXISTS (
      SELECT 1 FROM projects vp
      WHERE vp.project_key = ${alias}.entity_key AND vp.project_type = 'personal'))
    OR (${alias}.entity_type = 'membership' AND EXISTS (
      SELECT 1 FROM projects vp
      WHERE vp.project_key = substr(${alias}.entity_key, 1, instr(${alias}.entity_key, ':') - 1)
        AND vp.project_type = 'personal'))
  )`;
}

/**
 * True for task and comment events that cannot be tied to a project any more (the task or comment
 * row is gone), so their project type is unknown. Their `changes` are redacted for non-admins
 * instead of the event being dropped.
 */
export function unresolvedContentSql(alias = 'ae') {
  return `(
    (${alias}.entity_type = 'task' AND NOT EXISTS (
      SELECT 1 FROM tasks ut WHERE ut.task_key = ${alias}.entity_key))
    OR (${alias}.entity_type = 'comment' AND NOT EXISTS (
      SELECT 1 FROM task_comments uc WHERE uc.id = CAST(${alias}.entity_key AS INTEGER)))
  )`;
}

/** `WHERE` condition that drops personal-project events (for actors without platform.admin). */
export function visibleAuditCondition(alias = 'ae') {
  return `NOT ${personalContentSql(alias)}`;
}

/** Select expressions: `changes_json` (redacted to `{}` when unresolved) and a `redacted` flag. */
export function auditChangesSelect(restricted: boolean, alias = 'ae') {
  return restricted
    ? `CASE WHEN ${unresolvedContentSql(alias)} THEN '{}' ELSE ${alias}.changes_json END AS changes_json,
       ${unresolvedContentSql(alias)} AS redacted`
    : `${alias}.changes_json AS changes_json, 0 AS redacted`;
}
