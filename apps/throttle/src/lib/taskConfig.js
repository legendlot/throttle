// Stage definitions — order matters for kanban column order
export const STAGES = [
  {
    value: 'backlog',
    label: 'Backlog',
    color: '#555',
    description: 'Approved, not yet in a sprint',
  },
  {
    value: 'in_sprint',
    label: 'In Sprint',
    color: '#F2CD1A',
    description: 'Assigned to current sprint',
  },
  {
    value: 'in_progress',
    label: 'In Progress',
    color: '#213CE2',
    description: 'Actively being worked on',
  },
  {
    value: 'ext_blocked',
    label: 'Ext. Blocked',
    color: '#f59e0b',
    description: 'Blocked by external dependency',
  },
  {
    value: 'in_review',
    label: 'In Review',
    color: '#22d3ee',
    description: 'Submitted for approval',
  },
  {
    value: 'approved',
    label: 'Approved',
    color: '#22c55e',
    description: 'Work approved, pending final confirmation',
  },
  {
    value: 'delivered',
    label: 'Delivered',
    color: '#8b5cf6',
    description: 'Delivered to requester, awaiting feedback',
  },
  {
    value: 'done',
    label: 'Done',
    color: '#22c55e',
    description: 'Complete',
  },
  {
    value: 'abandoned',
    label: 'Abandoned',
    color: '#DE2A2A',
    description: 'Will not be completed',
  },
];

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent', color: '#DE2A2A' },
  { value: 'high',   label: 'High',   color: '#f59e0b' },
  { value: 'medium', label: 'Medium', color: '#F2CD1A' },
  { value: 'low',    label: 'Low',    color: '#555' },
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
    approved:    ['delivered', 'done', 'in_review'],
    delivered:   ['done', 'in_progress'],
    // done and abandoned are terminal — no transitions out
  },
  admin: {
    backlog:     ['in_sprint', 'abandoned'],
    in_sprint:   ['in_progress', 'backlog', 'abandoned'],
    in_progress: ['in_review', 'ext_blocked', 'in_sprint', 'abandoned'],
    ext_blocked: ['in_progress', 'abandoned'],
    in_review:   ['approved', 'in_progress', 'abandoned'],
    approved:    ['delivered', 'done', 'in_review', 'abandoned'],
    delivered:   ['done', 'in_progress', 'abandoned'],
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
