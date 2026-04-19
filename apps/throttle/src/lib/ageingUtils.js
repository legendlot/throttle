/**
 * Returns 'ok' | 'warning' | 'critical' | null
 * based on how many hours have passed since `sinceTimestamp`
 * and the provided thresholds.
 */
export function getAgeingStatus(sinceTimestamp, warningHours, criticalHours) {
  if (!sinceTimestamp) return null;
  const hoursElapsed = (Date.now() - new Date(sinceTimestamp).getTime()) / (1000 * 60 * 60);
  if (hoursElapsed >= criticalHours) return 'critical';
  if (hoursElapsed >= warningHours)  return 'warning';
  return 'ok';
}

export const AGEING_COLORS = {
  ok:       null,                      // no badge
  warning:  { color: '#f59e0b' },      // amber
  critical: { color: '#DE2A2A' },      // red
};

/**
 * Maps a task stage to the relevant timestamp column for ageing.
 */
export function getAgeingTimestamp(task) {
  switch (task.stage) {
    case 'in_sprint':    return task.created_at;
    case 'in_progress':  return task.in_progress_at || task.created_at;
    case 'in_review':    return task.in_review_at   || task.created_at;
    case 'approved':     return task.approved_at    || task.created_at;
    case 'delivered':    return task.delivered_at   || task.created_at;
    default:             return null;
  }
}
