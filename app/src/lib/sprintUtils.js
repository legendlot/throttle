/**
 * Sprint utilities
 * Sprints run Thursday → Wednesday (6 days)
 * DB enforces this with CHECK constraints
 */

/**
 * Get the next Thursday from today (or today if today is Thursday)
 * Returns a Date object
 */
export function getNextThursday(from = new Date()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const daysUntilThursday = day <= 4 ? 4 - day : 7 - day + 4;
  d.setDate(d.getDate() + daysUntilThursday);
  return d;
}

/**
 * Get the Wednesday 6 days after a given Thursday
 */
export function getSprintEndDate(startDate) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + 6);
  return d;
}

/**
 * Format a date to YYYY-MM-DD (for Supabase date columns)
 */
export function toDateString(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Generate sprint name from start and end dates
 * e.g. "Sprint 1 — Thu 17 Apr to Wed 23 Apr"
 */
export function generateSprintName(number, startDate, endDate) {
  const fmt = d => new Date(d).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
  return `Sprint ${number} — ${fmt(startDate)} to ${fmt(endDate)}`;
}

/**
 * Get days of the sprint as an array of Date objects
 * Thu, Fri, Sat, Sun, Mon, Tue, Wed
 */
export function getSprintDays(startDate) {
  const days = [];
  const start = new Date(startDate);
  for (let i = 0; i <= 6; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Check if a task's due_date falls on a given day
 */
export function taskDueOnDay(task, day) {
  if (!task.due_date) return false;
  const taskDate = new Date(task.due_date).toDateString();
  const dayDate = new Date(day).toDateString();
  return taskDate === dayDate;
}

/**
 * Get sprint status label
 */
export function getSprintStatusLabel(sprint) {
  if (!sprint) return 'No active sprint';
  const now = new Date();
  const end = new Date(sprint.end_date);
  end.setHours(23, 59, 59);
  const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return 'Overdue — close sprint';
  if (daysLeft === 0) return 'Last day';
  return `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`;
}

/**
 * Validate that a date string is a Thursday
 */
export function isThursday(dateString) {
  return new Date(dateString).getDay() === 4;
}
