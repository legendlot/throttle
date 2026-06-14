/* ════════════════════════════════════════════════════════════════
   Throttle — config + seed data (ESM port of the prototype data.jsx).
   Config maps (products / stages / priorities / channels / request
   types / manual) are the real design-system vocabulary used by every
   screen. The TASKS / REQUESTS / SPRINTS / KPI / social arrays are SEED
   fallbacks — screens prefer live data from the brand schema + worker
   and fall back to these only when there is no session or a read fails,
   so the UI is always populated and pixel-correct.
   ════════════════════════════════════════════════════════════════ */

// ── Vehicle characters (products) ────────────────────────────────
export const PRODUCTS = [
  { code: 'FLARE',     sub: 'Drift Specialist',  accent: '#F2CD1A', short: 'FLR' },
  { code: 'NIGHT WOLF',sub: 'Precision in Dark', accent: '#6d83ff', short: 'NWF' },
  { code: 'GHOST',     sub: 'Elusive. Fast.',    accent: '#9aa0ad', short: 'GHT' },
  { code: 'IRIS',      sub: 'All-Terrain',       accent: '#4ade80', short: 'IRS' },
  { code: 'TITAN',     sub: 'Built To Take Hits',accent: '#f97316', short: 'TTN' },
  { code: 'BUMBLE',    sub: 'Off-Road Monster',  accent: '#fbbf24', short: 'BMB' },
  { code: 'SHADOW',    sub: 'Pure Tarmac',       accent: '#b46bff', short: 'SHD' },
  { code: 'KNOX',      sub: 'Big Wheels. Dirt.', accent: '#22d3ee', short: 'KNX' },
];
export const productByCode = Object.fromEntries(PRODUCTS.map(p => [p.code, p]));

// ── Brand team (seed) ────────────────────────────────────────────
export const TEAM = [
  { id: 'u1', name: 'Meera Krishnan', role: 'admin',  discipline: 'Brand Lead',  initial: 'M' },
  { id: 'u2', name: 'Aarav Menon',    role: 'lead',   discipline: 'Design Lead', initial: 'A' },
  { id: 'u3', name: 'Diya Sharma',    role: 'member', discipline: 'Designer',    initial: 'D' },
  { id: 'u4', name: 'Rohan Gupta',    role: 'member', discipline: 'Designer',    initial: 'R' },
  { id: 'u5', name: 'Kabir Reddy',    role: 'member', discipline: 'Photo / Video', initial: 'K' },
  { id: 'u6', name: 'Vihaan Rao',     role: 'member', discipline: 'Photo / Video', initial: 'V' },
  { id: 'u7', name: 'Ishaan Nair',    role: 'member', discipline: '3D / Motion',  initial: 'I' },
  { id: 'u8', name: 'Ananya Iyer',    role: 'member', discipline: 'Copywriter',   initial: 'AN' },
];
export const teamById = Object.fromEntries(TEAM.map(t => [t.id, t]));

// ── Stage + priority config (mirrors taskConfig.js) ──────────────
export const STAGES = [
  { value: 'backlog',     label: 'Backlog',      color: '#7a7d87' },
  { value: 'in_sprint',   label: 'In Sprint',    color: '#F2CD1A' },
  { value: 'in_progress', label: 'In Progress',  color: '#6d83ff' },
  { value: 'ext_blocked', label: 'Ext. Blocked', color: '#fbbf24' },
  { value: 'in_review',   label: 'In Review',    color: '#22d3ee' },
  { value: 'approved',    label: 'Approved',     color: '#4ade80' },
  { value: 'delivered',   label: 'Delivered',    color: '#b46bff' },
];
export const stageByVal = Object.fromEntries(STAGES.map(s => [s.value, s]));
export const PRIORITY = {
  urgent: { label: 'Urgent', color: '#ff7a7a' },
  high:   { label: 'High',   color: '#fbbf24' },
  medium: { label: 'Medium', color: '#F2CD1A' },
  low:    { label: 'Low',    color: '#7a7d87' },
};
export const DTYPE = {
  graphic: 'Graphic', video: 'Video', photo: 'Photo', '3d_render': '3D Render',
  copy: 'Copy', deck: 'Deck', social_post: 'Social', ad_creative: 'Ad', listing_image: 'Listing',
};

// ── Active production tasks (seed) ───────────────────────────────
const T = (n, title, stage, priority, type, product, ownerId, collabs, due, flags) => ({
  id: 'T' + n, num: n, title, stage, priority, type, product, ownerId,
  collabs: collabs || 0, due, ...(flags || {}),
});
export const TASKS = [
  T(118, 'Flare hero listing images — Amazon A+', 'in_review', 'urgent', 'listing_image', 'FLARE', 'u3', 1, '13 Jun', { age: 'crit' }),
  T(121, 'Night Wolf launch reel — 30s cut', 'in_review', 'high', 'video', 'NIGHT WOLF', 'u5', 0, '14 Jun', { age: 'warn' }),
  T(109, 'Drift Club sale banner set (web + email)', 'in_review', 'medium', 'graphic', null, 'u4', 1, '15 Jun'),
  T(124, 'Titan packaging sticker — print-ready', 'in_progress', 'high', 'graphic', 'TITAN', 'u3', 0, '16 Jun'),
  T(126, 'Ghost 3D product render — hero angle', 'in_progress', 'medium', '3d_render', 'GHOST', 'u7', 0, '17 Jun'),
  T(127, 'Iris PDP video — tutorial edit', 'in_progress', 'medium', 'video', 'IRIS', 'u6', 1, '18 Jun'),
  T(130, 'Bumble Meta ad — static carousel', 'in_progress', 'low', 'ad_creative', 'BUMBLE', 'u4', 0, '19 Jun'),
  T(131, 'Knox off-road comic — script', 'in_progress', 'medium', 'copy', 'KNOX', 'u8', 0, '20 Jun'),
  T(112, 'Shadow tarmac shoot — colour grade', 'ext_blocked', 'high', 'photo', 'SHADOW', 'u5', 0, '14 Jun', { age: 'warn', blocked: 'Awaiting product samples' }),
  T(133, 'Sale event WhatsApp graphic pack', 'in_sprint', 'medium', 'graphic', null, 'u3', 0, '21 Jun'),
  T(134, 'Flare social static — drift series', 'in_sprint', 'low', 'social_post', 'FLARE', 'u4', 0, '22 Jun'),
  T(135, 'Night Wolf box sticker', 'in_sprint', 'medium', 'graphic', 'NIGHT WOLF', 'u3', 0, '23 Jun'),
  T(136, 'Titan listing refresh — Flipkart', 'in_sprint', 'low', 'listing_image', 'TITAN', 'u4', 0, '24 Jun'),
  T(137, 'Iris reel script — launch teaser', 'in_sprint', 'medium', 'copy', 'IRIS', 'u8', 0, '21 Jun'),
  T(140, 'Brand store refresh — Amazon', 'backlog', 'low', 'graphic', null, 'u3', 0, '28 Jun'),
  T(141, 'Ghost AI video — 15s loop', 'backlog', 'medium', 'video', 'GHOST', 'u7', 0, '30 Jun'),
  T(142, 'Office wall mural — Drift Club', 'backlog', 'low', 'graphic', null, 'u4', 0, '02 Jul'),
  T(106, 'Flare emailer header — launch', 'approved', 'medium', 'graphic', 'FLARE', 'u3', 0, '12 Jun'),
  T(101, 'Night Wolf hero banner — homepage', 'approved', 'high', 'graphic', 'NIGHT WOLF', 'u4', 1, '11 Jun'),
  T(98,  'Titan reel — off-road montage', 'delivered', 'medium', 'video', 'TITAN', 'u6', 0, '10 Jun'),
  T(95,  'Bumble listing images — Amazon', 'delivered', 'low', 'listing_image', 'BUMBLE', 'u3', 0, '09 Jun'),
];

// ── Dashboard KPIs (with sparkline trends) ───────────────────────
export const KPIS = [
  { key: 'in_review',  label: 'In Review',    value: 3,    delta: '+1',  dir: 'up',   tone: 'info',  spark: [1,2,2,1,3,2,3] },
  { key: 'overdue',    label: 'Overdue',      value: 2,    delta: '+2',  dir: 'up',   tone: 'bad',   spark: [0,0,1,0,1,1,2] },
  { key: 'blocked',    label: 'Ext. Blocked', value: 1,    delta: '0',   dir: 'flat', tone: 'warn',  spark: [1,1,2,1,1,1,1] },
  { key: 'completion', label: 'Completion',   value: '78%',delta: '+6',  dir: 'up',   tone: 'ok',    spark: [60,64,68,70,72,74,78] },
  { key: 'spillover',  label: 'Spillovers',   value: 4,    delta: '-1',  dir: 'down', tone: 'warn',  spark: [6,6,5,5,4,5,4] },
];

// ── "Needs you" action queue ─────────────────────────────────────
export const ACTIONS = [
  { id: 'a1', kind: 'approve',  taskId: 'T118', label: 'Flare A+ images awaiting your approval', meta: 'T-118 · Diya · urgent', tone: 'bad',  age: '6h' },
  { id: 'a2', kind: 'approve',  taskId: 'T121', label: 'Night Wolf launch reel — review', meta: 'T-121 · Kabir · high', tone: 'info', age: '1d' },
  { id: 'a3', kind: 'request',  label: 'New request: Sale Event — Independence Day', meta: 'From Ananya · 8 deliverables', tone: 'warn', age: '2h' },
  { id: 'a4', kind: 'blocked',  taskId: 'T112', label: 'Shadow shoot blocked — needs samples', meta: 'T-112 · Kabir · 2d in blocked', tone: 'warn', age: '2d' },
  { id: 'a5', kind: 'feedback', taskId: 'T98',  label: 'Titan reel delivered — close the loop', meta: 'T-98 · awaiting requester feedback', tone: 'ok', age: '1d' },
];

// ── Team workload (active tasks per person) ──────────────────────
export const WORKLOAD = TEAM.filter(t => t.role !== 'admin').map(p => {
  const own = TASKS.filter(t => t.ownerId === p.id);
  return {
    ...p,
    total: own.length,
    inProgress: own.filter(t => t.stage === 'in_progress').length,
    inReview: own.filter(t => t.stage === 'in_review').length,
    blocked: own.filter(t => t.stage === 'ext_blocked').length,
    queued: own.filter(t => ['in_sprint','backlog'].includes(t.stage)).length,
  };
}).filter(p => p.total > 0).sort((a,b) => b.total - a.total);

// ── Deliverables output (sprint, by day) ─────────────────────────
export const OUTPUT = [
  { day: 'Mon 09', graphic: 3, video: 1, photo: 0, listing: 2, social: 1, copy: 1 },
  { day: 'Tue 10', graphic: 2, video: 2, photo: 1, listing: 0, social: 2, copy: 0 },
  { day: 'Wed 11', graphic: 4, video: 0, photo: 2, listing: 1, social: 1, copy: 2 },
  { day: 'Thu 12', graphic: 1, video: 1, photo: 0, listing: 3, social: 0, copy: 1 },
  { day: 'Fri 13', graphic: 3, video: 2, photo: 1, listing: 1, social: 3, copy: 0 },
];
export const OUTPUT_COLS = [
  { key: 'graphic', label: 'Graphic' }, { key: 'video', label: 'Video' },
  { key: 'photo', label: 'Photo' }, { key: 'listing', label: 'Listing' },
  { key: 'social', label: 'Social' }, { key: 'copy', label: 'Copy' },
];

// ── Activity feed ────────────────────────────────────────────────
export const ACTIVITY = [
  { id: 'e1', who: 'Diya Sharma',  what: 'submitted', target: 'Flare A+ listing images', detail: 'moved to In Review', t: '14m ago', kind: 'review', taskId: 'T118' },
  { id: 'e2', who: 'Aarav Menon',  what: 'approved',  target: 'Night Wolf hero banner', detail: 'work approved', t: '40m ago', kind: 'approve', taskId: 'T101' },
  { id: 'e3', who: 'Kabir Reddy',  what: 'flagged',   target: 'Shadow tarmac shoot', detail: 'blocked — awaiting samples', t: '1h ago', kind: 'block', taskId: 'T112' },
  { id: 'e4', who: 'Ananya Iyer',  what: 'opened',    target: 'Sale Event — Independence Day', detail: 'new request · 8 items', t: '2h ago', kind: 'request' },
  { id: 'e5', who: 'Vihaan Rao',   what: 'delivered', target: 'Titan off-road reel', detail: 'delivered to requester', t: '3h ago', kind: 'deliver', taskId: 'T98' },
  { id: 'e6', who: 'Ishaan Nair',  what: 'started',   target: 'Ghost 3D product render', detail: 'moved to In Progress', t: '5h ago', kind: 'start', taskId: 'T126' },
];

// ── Social calendar ──────────────────────────────────────────────
export const CHANNELS = {
  instagram: { label: 'Instagram', color: '#e1306c', short: 'IG' },
  youtube:   { label: 'YouTube',   color: '#ff4d4d', short: 'YT' },
  whatsapp:  { label: 'WhatsApp',  color: '#25d366', short: 'WA' },
  linkedin:  { label: 'LinkedIn',  color: '#4f9cff', short: 'IN' },
};
export const POST_STATUS = {
  posted:    { label: 'Posted',    color: '#4ade80' },
  scheduled: { label: 'Scheduled', color: '#6d83ff' },
  draft:     { label: 'Draft',     color: '#7a7d87' },
  review:    { label: 'In Review', color: '#22d3ee' },
};
export const SOCIAL_WEEK = [
  { date: '09', dow: 'MON', label: 'Mon 9', posts: [
    { id: 'p1', time: '10:00', channel: 'instagram', product: 'FLARE', title: 'Drift series — reel 01', status: 'posted', fmt: 'Reel' },
    { id: 'p2', time: '18:30', channel: 'whatsapp', product: null, title: 'Drift Club drop alert', status: 'posted', fmt: 'Broadcast' },
  ]},
  { date: '10', dow: 'TUE', label: 'Tue 10', posts: [
    { id: 'p3', time: '12:00', channel: 'instagram', product: 'NIGHT WOLF', title: 'Own the night — carousel', status: 'posted', fmt: 'Carousel' },
  ]},
  { date: '11', dow: 'WED', label: 'Wed 11', posts: [
    { id: 'p4', time: '11:00', channel: 'youtube', product: 'IRIS', title: 'All-terrain tutorial', status: 'scheduled', fmt: 'Video' },
    { id: 'p5', time: '17:00', channel: 'instagram', product: 'TITAN', title: 'Built to take hits — story', status: 'scheduled', fmt: 'Story' },
  ]},
  { date: '12', dow: 'THU', label: 'Thu 12', posts: [
    { id: 'p6', time: '13:00', channel: 'linkedin', product: null, title: 'Behind the build — studio', status: 'review', fmt: 'Post' },
  ]},
  { date: '13', dow: 'FRI', label: 'Fri 13', posts: [
    { id: 'p7', time: '10:30', channel: 'instagram', product: 'FLARE', title: 'Corner fast — reel 02', status: 'scheduled', fmt: 'Reel' },
    { id: 'p8', time: '15:00', channel: 'youtube', product: 'GHOST', title: 'Ghost on corners — short', status: 'draft', fmt: 'Short' },
    { id: 'p9', time: '19:00', channel: 'whatsapp', product: null, title: 'Weekend drift challenge', status: 'draft', fmt: 'Broadcast' },
  ]},
  { date: '14', dow: 'SAT', label: 'Sat 14', posts: [
    { id: 'p10', time: '11:00', channel: 'instagram', product: 'BUMBLE', title: 'Off-road monster — carousel', status: 'draft', fmt: 'Carousel' },
  ]},
  { date: '15', dow: 'SUN', label: 'Sun 15', posts: [] },
];

// ── Request types (lucide icon names) ────────────────────────────
export const REQ_TYPES = {
  launch_pack:     { label: 'Launch Pack',      icon: 'rocket' },
  product_creative:{ label: 'Product Creative', icon: 'box' },
  social_media:    { label: 'Social Media',     icon: 'send' },
  advertising:     { label: 'Advertising',      icon: 'megaphone' },
  photo_video:     { label: 'Photo & Video',    icon: 'film' },
  copy_script:     { label: 'Copy & Script',    icon: 'type' },
  design_brand:    { label: 'Design & Brand',   icon: 'palette' },
  motion_3d:       { label: '3D & Motion',      icon: 'gauge' },
  sale_event:      { label: 'Sale Event',       icon: 'flag' },
  brand_initiative:{ label: 'Brand Initiative', icon: 'zap' },
};
export const REQ_STATUS = {
  pending:     { label: 'Pending',     tone: 'warn' },
  approved:    { label: 'Approved',    tone: 'ok' },
  info_needed: { label: 'Info Needed', tone: 'info' },
  rejected:    { label: 'Rejected',    tone: 'bad' },
  delivered:   { label: 'Delivered',   tone: 'brand' },
};
// ── Requests (intake — seed) ─────────────────────────────────────
const R = (id, type, title, who, wi, status, products, age, ageTone, date, items, note) => ({
  id, type, title, who, wi, status, products: products || [], age, ageTone, date, items, note,
});
export const REQUESTS = [
  R('R-241', 'sale_event',      'Independence Day Sale — full asset pack', 'Ananya Iyer', 'AN', 'pending', [], '2h', 'ok', '13 Jun', 8),
  R('R-240', 'launch_pack',     'KNOX off-road launch pack', 'Rohan Gupta', 'R', 'pending', ['KNOX'], '6h', 'ok', '13 Jun', 9),
  R('R-239', 'product_creative','Flare A+ refresh — Amazon', 'Diya Sharma', 'D', 'pending', ['FLARE'], '1d', 'warn', '12 Jun', null),
  R('R-238', 'advertising',     'Night Wolf Meta ad set — Q3 push', 'Kabir Reddy', 'K', 'info_needed', ['NIGHT WOLF'], '2d', 'bad', '11 Jun', null, 'Need final CTA + budget tier'),
  R('R-237', 'photo_video',     'Shadow tarmac shoot + edit', 'Vihaan Rao', 'V', 'approved', ['SHADOW'], '3d', 'ok', '10 Jun', 2),
  R('R-236', 'copy_script',     'Iris launch teaser — reel script', 'Ananya Iyer', 'AN', 'approved', ['IRIS'], '3d', 'ok', '10 Jun', null),
  R('R-235', 'design_brand',    'Drift Club office mural concepts', 'Meera Krishnan', 'M', 'approved', [], '4d', 'ok', '09 Jun', null),
  R('R-234', 'motion_3d',       'Ghost hero render — 3 angles', 'Ishaan Nair', 'I', 'delivered', ['GHOST'], '5d', 'ok', '08 Jun', null),
  R('R-233', 'social_media',    'Bumble off-road carousel series', 'Rohan Gupta', 'R', 'rejected', ['BUMBLE'], '5d', 'ok', '08 Jun', null, 'Out of scope — fold into July calendar'),
  R('R-232', 'product_creative','Titan packaging + box sticker', 'Diya Sharma', 'D', 'delivered', ['TITAN'], '6d', 'ok', '07 Jun', 2),
];

// ── Sprints (seed) ───────────────────────────────────────────────
export const SPRINTS = [
  { id: 'S-24', name: 'Sprint S-24', range: 'Jun 9 – 20', status: 'active',   committed: 21, done: 12, spill: 4 },
  { id: 'S-23', name: 'Sprint S-23', range: 'May 26 – Jun 6', status: 'closed', committed: 24, done: 22, spill: 2 },
  { id: 'S-22', name: 'Sprint S-22', range: 'May 12 – 23', status: 'closed', committed: 19, done: 18, spill: 1 },
  { id: 'S-25', name: 'Sprint S-25', range: 'Jun 23 – Jul 4', status: 'planned', committed: 0, done: 0, spill: 0 },
];
export const BURNDOWN = {
  ideal:  [21, 18.9, 16.8, 14.7, 12.6, 10.5, 8.4, 6.3, 4.2, 2.1, 0],
  actual: [21, 20, 19, 17, 16, 14, 13, 11, 9, null, null],
  days:   ['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10',''],
};
export const CAPACITY = [
  { id: 'u3', cap: 6, committed: 6, done: 4 },
  { id: 'u4', cap: 6, committed: 5, done: 3 },
  { id: 'u5', cap: 5, committed: 4, done: 2 },
  { id: 'u6', cap: 5, committed: 3, done: 2 },
  { id: 'u7', cap: 4, committed: 2, done: 1 },
  { id: 'u8', cap: 4, committed: 3, done: 2 },
];

// ── System Manual ────────────────────────────────────────────────
export const MANUAL = [
  { id: 'start', label: 'Getting Started', icon: 'zap', body: [
    { h: 'What Throttle is' },
    { p: 'Throttle is the Brand OS for Legend of Toys. Every piece of creative the brand team makes starts here as a request, moves through the production board, ships inside a sprint, and is delivered back to whoever asked for it.' },
    { p: 'One rule. Nothing gets made off-book. If it is not a request, it does not exist.' },
    { h: 'The flow' },
    { steps: ['Someone files a request', 'A lead approves it', 'It becomes one or more tasks on the board', 'A designer owns it through the sprint', 'It goes to review, gets approved, then delivered', 'The requester closes the loop with feedback'] },
    { h: 'Signing in' },
    { p: 'Access is Google Workspace, legendoftoys.com accounts only. Your role is set in Settings and decides what you can see and do. New here. Ask Meera.' },
  ]},
  { id: 'navigate', label: 'Finding Your Way', icon: 'command', body: [
    { h: 'The shell' },
    { p: 'The left sidebar is grouped by what you are doing: Overview, Production, Channels, and the System area. Collapse it from the logo to reclaim space. The topbar shows where you are, the active sprint, and a live indicator when data is current.' },
    { h: 'Command palette' },
    { p: 'Press Cmd K (Ctrl K on Windows) anywhere to jump. Search screens, open a task by name or number, deep-link a manual section, or quick-create a request, a social post, or a sprint plan.' },
    { table: [['Cmd K', 'Open the command palette'], ['Esc', 'Close any drawer, modal, or palette'], ['Enter', 'Post a comment in the task drawer']] },
  ]},
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', body: [
    { h: 'The command view' },
    { p: 'Your morning read on the brand team. The hero greets you with what needs attention right now. Below it, five live numbers: in review, overdue, externally blocked, sprint completion, and spillovers.' },
    { h: 'Needs you' },
    { p: 'A single queue of everything waiting on you. Approvals to give, new requests to triage, blocked work, and deliveries waiting on requester feedback. Click any row to jump straight to it.' },
    { h: 'Activity, workload, output' },
    { p: 'A real-time feed of what the team just did, a per-person workload bar so nobody is buried or idle, and a chart of deliverables shipped over the last seven days.' },
  ]},
  { id: 'roles', label: 'Roles & Access', icon: 'users', body: [
    { h: 'Four roles' },
    { table: [['Requester', 'Files requests. Sees only their own work.'], ['Member', 'Works the board. Moves and delivers their own tasks.'], ['Lead', 'Approves requests, plans sprints, reviews work.'], ['Admin', 'Everything, plus Settings and the team.']] },
    { p: 'Role is set in Settings. Access follows the role everywhere. The nav, the board, the dashboard and the approval controls all adapt to what you are allowed to do.' },
  ]},
  { id: 'requests', label: 'Requests', icon: 'inbox', body: [
    { h: 'Creative intake' },
    { p: 'Requests are the only front door. Hit New Request anywhere, or press Cmd K and pick it. A short wizard walks you through three steps: choose a type, fill the details (title, products, priority, channels, deadline, brief), then review and submit.' },
    { h: 'Ten ways in' },
    { p: 'Pick the type that matches the work. Each type asks for exactly what production needs, no more, no less. Launch Pack and Sale Event fan out into many tasks at once.' },
    { table: [['Launch Pack', 'Full asset bundle for a new product'], ['Product Creative', 'Listings, A+, stickers, manuals'], ['Sale Event', 'Banners, ads, social for a promo'], ['Advertising', 'Static, video, marketplace ads'], ['Photo & Video', 'Shoots and edits'], ['Copy & Script', 'Scripts, descriptions, captions'], ['Design & Brand', 'Identity, decks, brand pieces'], ['3D & Motion', 'Renders, loops, motion'], ['Social Media', 'Calendar posts and series'], ['Brand Initiative', 'Internal, brand-team-led work']] },
    { h: 'Triage' },
    { p: 'Leads approve, hold, or reject from the request drawer or inline on a card. Approve fans the request out into tasks in Backlog and notifies the requester. Hold asks for more information. Reject closes it with a reason.' },
  ]},
  { id: 'board', label: 'The Board', icon: 'board', body: [
    { h: 'Seven stages' },
    { p: 'Work moves left to right. Drag a card between columns to change its stage, or open the card and use the stage controls. You can only move a task to a stage your role allows. Switch to the table view for a dense list.' },
    { table: [['Backlog', 'Approved, not yet scheduled'], ['In Sprint', 'Committed to the current sprint'], ['In Progress', 'Actively being worked'], ['Ext. Blocked', 'Waiting on something outside the team'], ['In Review', 'Submitted for approval'], ['Approved', 'Signed off, ready to hand back'], ['Delivered', 'Handed to the requester']] },
    { h: 'The task drawer' },
    { p: 'Click any card for the full picture: brief, owner and collaborators, product, due date, the stage mover, context actions (submit, approve, deliver), and a comment thread. Comments post on Enter.' },
    { h: 'Ageing' },
    { p: 'A dot on a card turns amber, then red, when a task sits in a stage too long. Thresholds are per stage and live in Settings.' },
  ]},
  { id: 'sprints', label: 'Sprints', icon: 'target', body: [
    { h: 'Weekly cadence' },
    { p: 'Sprints run one week, Thursday to Wednesday. A sprint closes automatically on Wednesday night, its health is recorded, and the next sprint is created for you. Anything unfinished carries into the next sprint, flagged. Spillover is data, not blame.' },
    { h: 'Reading the sprint' },
    { p: 'The top row tracks committed, completed, remaining, spill risk and days left. Burndown shows the ideal path against where the team actually is. Velocity compares done versus committed across recent sprints, and the workload panel shows each person’s load.' },
    { h: 'Planning' },
    { p: 'Leads hit Plan from backlog to open the planner. Drag approved backlog tasks into the sprint, watch the per-person load, then Commit. Committing moves those tasks into the sprint on the board.' },
  ]},
  { id: 'social', label: 'Social Calendar', icon: 'calendar', body: [
    { h: 'Plan the feed' },
    { p: 'The Social calendar runs the brand’s content across Instagram, YouTube, WhatsApp and LinkedIn. Switch between a focused week view and a month-at-a-glance with a coverage ring and weekly bars so gaps are obvious.' },
    { h: 'Scheduling' },
    { p: 'Hit Schedule post, or Add on any day, to drop a post: channel, caption, product, format, day and time. Each post carries a status, draft through scheduled and posted. Click a post to open its detail.' },
    { h: 'Moving posts' },
    { p: 'In month view, drag a post chip from one day to another to reschedule it. Click any day for a popover of everything planned that day.' },
  ]},
  { id: 'delivery', label: 'Delivery & Feedback', icon: 'send', body: [
    { h: 'Closing the loop' },
    { p: 'Approved work is delivered to the requester, who gives feedback. Accept closes the task. Asking for changes sends it back to In Progress as an iteration. The loop is not closed until the requester responds.' },
    { p: 'Delivered-but-silent work surfaces on the dashboard so nothing rots quietly. A lead can close a stale delivery if a requester goes dark.' },
  ]},
  { id: 'settings', label: 'Settings', icon: 'settings', body: [
    { h: 'Admin controls' },
    { p: 'Settings is where admins run the system. Four tabs.' },
    { table: [['Team', 'People, their disciplines and roles. Invite teammates.'], ['Workflow', 'Ageing thresholds per stage, when a task turns amber then red.'], ['Request Types', 'Which intake types are open to requesters.'], ['Notifications', 'What pings you, from reviews to the daily sprint digest.']] },
  ]},
];

// ── Social month (June 2026, starts Monday, today = 14) ──────────
const _mrand = s => { const x = Math.sin(s * 99.13) * 10000; return x - Math.floor(x); };
const _M_PROD = ['FLARE', 'NIGHT WOLF', 'GHOST', 'IRIS', 'TITAN', 'BUMBLE', 'SHADOW', 'KNOX', null, null];
const _M_CH = ['instagram', 'instagram', 'youtube', 'whatsapp', 'linkedin'];
const _M_FMT = { instagram: ['Reel', 'Carousel', 'Story'], youtube: ['Video', 'Short'], whatsapp: ['Broadcast'], linkedin: ['Post'] };
const _M_DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
export const SOCIAL_MONTH = [];
for (let day = 1; day <= 30; day++) {
  const dowIdx = (day - 1) % 7;
  let n;
  const r = _mrand(day);
  if (dowIdx === 6) n = r < 0.82 ? 0 : 1;
  else if (dowIdx === 5) n = r < 0.55 ? 0 : 1;
  else n = 1 + Math.floor(_mrand(day * 1.7) * 3);
  if (day > 20 && _mrand(day * 2.3) < 0.42) n = 0;
  const posts = [];
  for (let i = 0; i < n; i++) {
    const ch = _M_CH[Math.floor(_mrand(day * 7 + i * 3) * _M_CH.length)];
    const status = day < 14 ? 'posted' : day <= 20 ? (_mrand(day + i) < 0.3 ? 'review' : 'scheduled') : (_mrand(day + i) < 0.55 ? 'draft' : 'scheduled');
    const product = _M_PROD[Math.floor(_mrand(day * 5 + i * 11) * _M_PROD.length)];
    const fmts = _M_FMT[ch]; const fmt = fmts[Math.floor(_mrand(day * 3 + i) * fmts.length)];
    posts.push({ id: `m${day}_${i}`, channel: ch, status, product, time: '12:00', fmt, title: `${product || 'Brand'} ${fmt.toLowerCase()}` });
  }
  SOCIAL_MONTH.push({ day, dow: _M_DOW[dowIdx], dowIdx, posts });
}
export const MONTH_META = { label: 'June 2026', leadBlanks: 0, days: 30, today: 14 };

// ── Sprint planning — backlog candidates (seed) ──────────────────
export const PLAN_BACKLOG = [
  { id: 'B1', title: 'Knox off-road hero — listing set', type: 'listing_image', product: 'KNOX', est: 3, ownerId: 'u3', priority: 'high' },
  { id: 'B2', title: 'Independence Day sale — web banners', type: 'graphic', product: null, est: 2, ownerId: 'u4', priority: 'high' },
  { id: 'B3', title: 'Ghost AI launch video — 15s loop', type: 'video', product: 'GHOST', est: 3, ownerId: 'u7', priority: 'medium' },
  { id: 'B4', title: 'Iris all-terrain reel — edit', type: 'video', product: 'IRIS', est: 2, ownerId: 'u6', priority: 'medium' },
  { id: 'B5', title: 'Drift Club mural — final art', type: 'graphic', product: null, est: 2, ownerId: 'u4', priority: 'low' },
  { id: 'B6', title: 'Titan box sticker — print pack', type: 'graphic', product: 'TITAN', est: 1, ownerId: 'u3', priority: 'medium' },
  { id: 'B7', title: 'Bumble Meta carousel — Q3', type: 'ad_creative', product: 'BUMBLE', est: 2, ownerId: 'u4', priority: 'low' },
  { id: 'B8', title: 'Flare launch script — teaser', type: 'copy', product: 'FLARE', est: 1, ownerId: 'u8', priority: 'medium' },
  { id: 'B9', title: 'Shadow tarmac stills — colour grade', type: 'photo', product: 'SHADOW', est: 2, ownerId: 'u5', priority: 'high' },
  { id: 'B10', title: 'Night Wolf 3D render — angles', type: '3d_render', product: 'NIGHT WOLF', est: 3, ownerId: 'u7', priority: 'medium' },
  { id: 'B11', title: 'Brand store refresh — Amazon', type: 'graphic', product: null, est: 2, ownerId: 'u3', priority: 'low' },
  { id: 'B12', title: 'Sale event WhatsApp pack', type: 'graphic', product: null, est: 1, ownerId: 'u4', priority: 'medium' },
];
export const PLAN_CAPACITY = { u3: 6, u4: 6, u5: 5, u6: 5, u7: 5, u8: 4 };

// ── Persistence helpers ──────────────────────────────────────────
export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
}
export function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
}

// ── Display helpers ──────────────────────────────────────────────
export function initialsOf(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
export function firstName(name) { return name ? String(name).split(/\s+/)[0] : ''; }
export function taskTag(num) { return 'T-' + String(num ?? 0).padStart(3, '0'); }
