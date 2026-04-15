// Stage definitions — order matters for kanban column order
export const STAGES = [
  {
    value: 'backlog',
    label: 'Backlog',
    color: '#52525b', // zinc-600
    description: 'Approved, not yet in a sprint',
  },
  {
    value: 'in_sprint',
    label: 'In Sprint',
    color: '#3b82f6', // blue-500
    description: 'Assigned to current sprint',
  },
  {
    value: 'in_progress',
    label: 'In Progress',
    color: '#8b5cf6', // violet-500
    description: 'Actively being worked on',
  },
  {
    value: 'ext_blocked',
    label: 'Ext. Blocked',
    color: '#f59e0b', // amber-500
    description: 'Blocked by external dependency',
  },
  {
    value: 'in_review',
    label: 'In Review',
    color: '#06b6d4', // cyan-500
    description: 'Submitted for approval',
  },
  {
    value: 'approved',
    label: 'Approved',
    color: '#10b981', // emerald-500
    description: 'Work approved, pending final confirmation',
  },
  {
    value: 'done',
    label: 'Done',
    color: '#22c55e', // green-500
    description: 'Complete',
  },
  {
    value: 'abandoned',
    label: 'Abandoned',
    color: '#ef4444', // red-500
    description: 'Will not be completed',
  },
];

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent', color: '#ef4444' },
  { value: 'high',   label: 'High',   color: '#f97316' },
  { value: 'medium', label: 'Medium', color: '#eab308' },
  { value: 'low',    label: 'Low',    color: '#22c55e' },
];

// Valid stage transitions per role
// Key: current stage → Value: array of stages this role can move to
export const VALID_TRANSITIONS = {
  member: {
    in_sprint:   ['in_progress'],
    in_progress: ['in_review', 'ext_blocked'],
    ext_blocked: ['in_progress'],
    // members cannot move from any other stage
  },
  lead: {
    backlog:     ['in_sprint'],
    in_sprint:   ['in_progress', 'backlog', 'abandoned'],
    in_progress: ['in_review', 'ext_blocked', 'in_sprint', 'abandoned'],
    ext_blocked: ['in_progress', 'abandoned'],
    in_review:   ['approved', 'in_progress'],
    approved:    ['done', 'in_review'],
    // done and abandoned are terminal — no transitions out
  },
  admin: {
    backlog:     ['in_sprint', 'abandoned'],
    in_sprint:   ['in_progress', 'backlog', 'abandoned'],
    in_progress: ['in_review', 'ext_blocked', 'in_sprint', 'abandoned'],
    ext_blocked: ['in_progress', 'abandoned'],
    in_review:   ['approved', 'in_progress', 'abandoned'],
    approved:    ['done', 'in_review', 'abandoned'],
  },
};

export function getValidTransitions(currentStage, role) {
  const roleTransitions = VALID_TRANSITIONS[role] || VALID_TRANSITIONS.member;
  return roleTransitions[currentStage] || [];
}

export function canMoveTask(task, targetStage, role) {
  const valid = getValidTransitions(task.stage, role);
  return valid.includes(targetStage);
}

export function getStageConfig(value) {
  return STAGES.find(s => s.value === value) || STAGES[0];
}

export function getPriorityConfig(value) {
  return PRIORITIES.find(p => p.value === value) || PRIORITIES[2];
}

// Stages shown on the main board (excludes abandoned — shown separately)
export const BOARD_STAGES = STAGES.filter(s => s.value !== 'abandoned');

// Deliverable types (for task card display + editing)
export const DELIVERABLE_TYPES = [
  { value: 'graphic',       label: 'Graphic' },
  { value: 'video',         label: 'Video' },
  { value: 'photo',         label: 'Photo' },
  { value: '3d_render',     label: '3D Render' },
  { value: 'copy',          label: 'Copy' },
  { value: 'deck',          label: 'Deck' },
  { value: 'social_post',   label: 'Social Post' },
  { value: 'ad_creative',   label: 'Ad Creative' },
  { value: 'listing_image', label: 'Listing Image' },
  { value: 'other',         label: 'Other' },
];
