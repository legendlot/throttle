// app/src/lib/requestTypes.js

// ── LAUNCH PACK ──────────────────────────────────────────────────────────────
// Each item: { id, label, discipline, deliverable_type, default_on }
// discipline: 'designer' | 'copywriter' | 'photo_video' | '3d'
// On approval, one task is auto-created per checked item.

export const LAUNCH_PACK_ITEMS = [
  { id: 'listing_images',  label: 'Listing Images',      discipline: 'designer',    deliverable_type: 'listing_image', default_on: true },
  { id: 'aplus',           label: 'A+ / EBC Content',    discipline: 'designer',    deliverable_type: 'graphic',       default_on: true },
  { id: 'comic_graphics',  label: 'Comic (Graphics)',     discipline: 'designer',    deliverable_type: 'graphic',       default_on: true },
  { id: 'comic_script',    label: 'Comic (Script)',       discipline: 'copywriter',  deliverable_type: 'copy',          default_on: true },
  { id: 'box_sticker',     label: 'Box Sticker',          discipline: 'designer',    deliverable_type: 'graphic',       default_on: true },
  { id: 'manual',          label: 'Product Manual',       discipline: 'designer',    deliverable_type: 'graphic',       default_on: true },
  { id: 'packaging',       label: 'Packaging',            discipline: 'designer',    deliverable_type: 'graphic',       default_on: true },
  { id: 'pdp_video',       label: 'PDP Video',            discipline: 'photo_video', deliverable_type: 'video',         default_on: true },
  { id: 'tutorial_video',  label: 'Tutorial Video',       discipline: 'photo_video', deliverable_type: 'video',         default_on: false },
];

// ── SALE EVENT ITEMS ──────────────────────────────────────────────────────────
// Each item: { id, label, discipline, deliverable_type, default_on }
// On approval, one task is auto-created per checked item.

export const SALE_EVENT_ITEMS = [
  { id: 'website_banner',   label: 'Website Banner',      discipline: 'designer',    deliverable_type: 'graphic',      default_on: true  },
  { id: 'social_static',    label: 'Social Static Post',  discipline: 'designer',    deliverable_type: 'social_post',  default_on: true  },
  { id: 'social_story',     label: 'Social Story',        discipline: 'designer',    deliverable_type: 'graphic',      default_on: false },
  { id: 'reel',             label: 'Reel / Video',        discipline: 'photo_video', deliverable_type: 'video',        default_on: false },
  { id: 'meta_ad_static',   label: 'Meta Ad (Static)',    discipline: 'designer',    deliverable_type: 'ad_creative',  default_on: true  },
  { id: 'meta_ad_video',    label: 'Meta Ad (Video)',     discipline: 'photo_video', deliverable_type: 'ad_creative',  default_on: false },
  { id: 'google_display',   label: 'Google Display Ad',   discipline: 'designer',    deliverable_type: 'ad_creative',  default_on: false },
  { id: 'email_header',     label: 'Email Header',        discipline: 'designer',    deliverable_type: 'graphic',      default_on: false },
  { id: 'whatsapp_graphic', label: 'WhatsApp Graphic',    discipline: 'designer',    deliverable_type: 'graphic',      default_on: false },
  { id: 'pdp_refresh',      label: 'PDP Refresh (Website)', discipline: 'designer',  deliverable_type: 'graphic',      default_on: false },
  { id: 'homepage_changes', label: 'Homepage Changes',    discipline: 'designer',    deliverable_type: 'graphic',      default_on: false },
  { id: 'layout_changes',   label: 'Layout Changes',      discipline: 'designer',    deliverable_type: 'graphic',      default_on: false },
];

// ── REQUEST TYPE DEFINITIONS ─────────────────────────────────────────────────

export const REQUEST_TYPES = [
  {
    id: 'launch_pack',
    label: 'Launch Pack',
    description: 'Full asset bundle for a new product launch',
    icon: '🚀',
    brand_team_only: false,
    product_required: true,    // always product-scoped, single product only
    multi_product: false,       // one product per launch pack
    generates_multiple: true,   // generates one task per checked item
    fields: [
      // No template fields beyond the checklist — handled separately in the UI
    ],
  },
  {
    id: 'product_creative',
    label: 'Product Creative',
    description: 'Listing images, A+, stickers, manuals — anything tied to a specific product',
    icon: '📦',
    brand_team_only: false,
    product_required: true,
    multi_product: true,
    generates_multiple: false,
    fields: [
      { id: 'asset_type',     label: 'Asset Type',        type: 'select',   required: true,  options: ['Listing Images', 'A+ Content', 'Box Sticker', 'Product Manual', 'Packaging', 'PDP Video', 'Tutorial Video', 'Other'] },
      { id: 'is_revision',    label: 'Work Type',         type: 'toggle',   required: true,  options: ['New', 'Revision'] },
      { id: 'revision_ref',   label: 'What exists? (link or description)', type: 'text', required: false, conditional: { field: 'is_revision', value: 'Revision' } },
      { id: 'specs',          label: 'Specs / Dimensions',type: 'text',     required: false },
      { id: 'format',         label: 'File Format',       type: 'multiselect', required: false, options: ['PNG', 'PDF', 'SVG', 'AI', 'MP4', 'MOV', 'Other'] },
      { id: 'deadline',       label: 'Deadline',          type: 'date',     required: true },
      { id: 'notes',          label: 'Additional Notes',  type: 'textarea', required: false },
    ],
  },
  {
    id: 'social_media',
    label: 'Social Media',
    description: 'Posts, reels, stories, captions, content calendars',
    icon: '📱',
    brand_team_only: false,
    product_required: false,
    multi_product: true,
    generates_multiple: false,
    fields: [
      { id: 'platform',       label: 'Platform(s)',       type: 'multiselect', required: true,  options: ['Instagram', 'LinkedIn', 'YouTube', 'WhatsApp', 'Amazon', 'Flipkart', 'Other'] },
      { id: 'format',         label: 'Content Format',    type: 'select',   required: true,  options: ['Static Post', 'Carousel', 'Story', 'Reel', 'Video', 'Calendar', 'Caption Only'] },
      { id: 'caption_needed', label: 'Caption Required',  type: 'toggle',   required: true,  options: ['Yes', 'No'] },
      { id: 'post_date',      label: 'Desired Post Date', type: 'date',     required: true },
      { id: 'campaign_name',  label: 'Campaign Name (if part of one)', type: 'text', required: false },
      { id: 'reference',      label: 'Reference / Inspiration', type: 'text', required: false },
      { id: 'notes',          label: 'Additional Notes',  type: 'textarea', required: false },
    ],
  },
  {
    id: 'advertising',
    label: 'Advertising',
    description: 'Static ads, video ads, WA creatives, DSP, Amazon/Flipkart ads',
    icon: '📣',
    brand_team_only: false,
    product_required: false,
    multi_product: true,
    generates_multiple: false,
    fields: [
      { id: 'platform',       label: 'Platform(s)',       type: 'multiselect', required: true,  options: ['Meta', 'Google', 'Amazon DSP', 'Flipkart', 'WhatsApp', 'YouTube', 'OOH', 'Other'] },
      { id: 'ad_format',      label: 'Ad Format',         type: 'select',   required: true,  options: ['Static Banner', 'Carousel', 'Video', 'QUAD / Multi-image', 'Story Ad', 'Other'] },
      { id: 'sizes',          label: 'Sizes Required',    type: 'text',     required: true },
      { id: 'copy_provided',  label: 'Copy Provided',     type: 'toggle',   required: true,  options: ['Yes', 'No'] },
      { id: 'copy_text',      label: 'Copy Text',         type: 'textarea', required: false, conditional: { field: 'copy_provided', value: 'Yes' } },
      { id: 'cta',            label: 'CTA',               type: 'text',     required: true },
      { id: 'go_live_date',   label: 'Go-Live Date',      type: 'date',     required: true },
      { id: 'campaign_name',  label: 'Campaign Name',     type: 'text',     required: false },
      { id: 'reference',      label: 'Reference / Examples', type: 'text', required: false },
    ],
  },
  {
    id: 'photo_video_new',
    label: 'Photo & Video',
    description: 'Photoshoots, product videos, reels, edits — generates a shoot task and an edit task',
    icon: '🎬',
    brand_team_only: false,
    product_required: false,
    multi_product: true,
    generates_multiple: true,   // generates shoot + edit tasks
    fields: [
      { id: 'shoot_type',     label: 'Shoot Type',        type: 'select',   required: true,  options: ['Product', 'Lifestyle', 'Reel', 'Tutorial', 'Brand Video', 'Event', 'Other'] },
      { id: 'edit_required',  label: 'Edit Required',     type: 'toggle',   required: true,  options: ['Yes', 'No'], default: 'Yes' },
      { id: 'location',       label: 'Location',          type: 'text',     required: true },
      { id: 'talent_needed',  label: 'Talent / Subjects', type: 'text',     required: false },
      { id: 'delivery_format',label: 'Delivery Format',   type: 'multiselect', required: true, options: ['RAW', 'JPEG', 'MP4', 'MOV', 'Edited Reel', 'Other'] },
      { id: 'usage',          label: 'Usage',             type: 'select',   required: true,  options: ['Internal', 'Social', 'Paid Media', 'Amazon/Flipkart', 'All'] },
      { id: 'shoot_date',     label: 'Desired Shoot Date',type: 'date',     required: true },
      { id: 'shot_list',      label: 'Brief / Shot List', type: 'textarea', required: false },
      { id: 'reference',      label: 'Reference / Mood',  type: 'text',     required: false },
    ],
  },
  {
    id: 'copy_script',
    label: 'Copy & Script',
    description: 'Ad scripts, reel scripts, emailers, AMZ descriptions, comic scripts, voiceovers',
    icon: '✍️',
    brand_team_only: false,
    product_required: false,
    multi_product: true,
    generates_multiple: false,
    fields: [
      { id: 'content_type',   label: 'Content Type',      type: 'select',   required: true,  options: ['Ad Script', 'Reel Script', 'YouTube Script', 'Voiceover', 'Amazon Description', 'Emailer', 'Social Caption', 'Comic Script', 'Character / Lore', 'Web Copy', 'Other'] },
      { id: 'is_revision',    label: 'Work Type',         type: 'toggle',   required: true,  options: ['New', 'Revision'] },
      { id: 'revision_ref',   label: 'What exists? (link or description)', type: 'text', required: false, conditional: { field: 'is_revision', value: 'Revision' } },
      { id: 'word_count',     label: 'Approx. Word Count',type: 'text',     required: false },
      { id: 'tone',           label: 'Tone / Voice',      type: 'text',     required: true },
      { id: 'audience',       label: 'Target Audience',   type: 'text',     required: true },
      { id: 'key_messages',   label: 'Key Messages',      type: 'textarea', required: true },
      { id: 'where_used',     label: 'Where It Will Live',type: 'text',     required: true },
      { id: 'deadline',       label: 'Deadline',          type: 'date',     required: true },
      { id: 'reference',      label: 'Reference Links',   type: 'text',     required: false },
    ],
  },
  {
    id: 'design_brand',
    label: 'Design & Brand',
    description: 'Banners, packaging, merchandise, office assets, brand stores, identity work',
    icon: '🎨',
    brand_team_only: false,
    product_required: false,
    multi_product: false,
    generates_multiple: false,
    fields: [
      { id: 'asset_type',     label: 'Asset Type',        type: 'select',   required: true,  options: ['Homepage Banner', 'Collection Banner', 'Emailer Banner', 'Sale Banner', 'Brand Store (Amazon)', 'Brand Store (Flipkart)', 'Merchandise', 'Office Asset', 'ID / Business Card', 'Gift Wrap', 'Catalogue', 'Presentation / Deck', 'Other'] },
      { id: 'is_revision',    label: 'Work Type',         type: 'toggle',   required: true,  options: ['New', 'Revision'] },
      { id: 'revision_ref',   label: 'What exists?',      type: 'text',     required: false, conditional: { field: 'is_revision', value: 'Revision' } },
      { id: 'dimensions',     label: 'Dimensions / Specs',type: 'text',     required: false },
      { id: 'copy_provided',  label: 'Copy Provided',     type: 'toggle',   required: true,  options: ['Yes', 'No'] },
      { id: 'copy_text',      label: 'Copy Text',         type: 'textarea', required: false, conditional: { field: 'copy_provided', value: 'Yes' } },
      { id: 'format',         label: 'File Format',       type: 'multiselect', required: false, options: ['PNG', 'PDF', 'SVG', 'AI', 'Other'] },
      { id: 'deadline',       label: 'Deadline',          type: 'date',     required: true },
      { id: 'reference',      label: 'Reference / Inspiration', type: 'text', required: false },
    ],
  },
  {
    id: '3d_motion',
    label: '3D & Motion',
    description: '3D models, product renders, textures, animations, AI video',
    icon: '🎲',
    brand_team_only: false,
    product_required: false,
    multi_product: true,
    generates_multiple: false,
    fields: [
      { id: 'project_type',   label: 'Project Type',      type: 'select',   required: true,  options: ['Product Render', '3D Model', 'Texture', 'Animation', '3D for Social', 'AI Video', 'Environment', 'Other'] },
      { id: 'reference',      label: 'Reference Visuals', type: 'text',     required: true },
      { id: 'format',         label: 'File Format',       type: 'multiselect', required: true, options: ['PNG', 'MP4', 'GLB', 'OBJ', 'FBX', 'Other'] },
      { id: 'quality',        label: 'Render Quality',    type: 'select',   required: true,  options: ['Draft', 'Standard', 'High', 'Hero'] },
      { id: 'animation',      label: 'Animation Required',type: 'toggle',   required: true,  options: ['Yes', 'No'] },
      { id: 'duration',       label: 'Duration (seconds)',type: 'text',     required: false, conditional: { field: 'animation', value: 'Yes' } },
      { id: 'deadline',       label: 'Deadline',          type: 'date',     required: true },
      { id: 'notes',          label: 'Additional Notes',  type: 'textarea', required: false },
    ],
  },
  {
    id: 'sale_event',
    label: 'Sale Event',
    description: 'Banners, ads, and social assets for a sale or promotional event',
    icon: '🏷️',
    brand_team_only: false,
    product_required: false,
    multi_product: true,
    generates_multiple: true,   // generates one task per checked deliverable item
    fields: [
      { id: 'sale_name',   label: 'Sale / Event Name',       type: 'text',        required: true  },
      { id: 'channels',    label: 'Channels',                 type: 'multiselect', required: true,  options: ['Website', 'Social', 'Email', 'Paid Ads', 'Amazon', 'Flipkart', 'WhatsApp'] },
      { id: 'scope',       label: 'Sale Scope',               type: 'select',      required: true,  options: ['Sitewide', 'Category-wide', 'Specific Products'] },
      { id: 'sale_start',  label: 'Sale Goes Live',           type: 'date',        required: true  },
      { id: 'sale_end',    label: 'Sale Ends',                type: 'date',        required: true  },
      { id: 'deadline',    label: 'Assets Needed By',         type: 'date',        required: true  },
      { id: 'notes',       label: 'Brief / Additional Notes', type: 'textarea',    required: false },
    ],
  },
  {
    id: 'brand_initiative',
    label: 'Brand Initiative',
    description: 'Brand team projects — office branding, merchandise lines, LOT Universe, internal campaigns',
    icon: '⚡',
    brand_team_only: true,     // only visible to member, lead, admin
    product_required: false,
    multi_product: false,
    generates_multiple: false,
    fields: [
      { id: 'initiative_name',label: 'Initiative Name',   type: 'text',     required: true },
      { id: 'objective',      label: 'Objective',         type: 'textarea', required: true },
      { id: 'deliverables',   label: 'Deliverables (one per line)', type: 'textarea', required: true },
      { id: 'team_members',   label: 'Team Members Involved', type: 'text', required: false },
      { id: 'timeline',       label: 'Target Timeline',   type: 'text',     required: true },
      { id: 'reference',      label: 'Reference / Mood',  type: 'text',     required: false },
    ],
  },
];

export const getRequestType = (id) => REQUEST_TYPES.find(t => t.id === id);
export const getVisibleTypes = (role) =>
  REQUEST_TYPES.filter(t => !t.brand_team_only || ['member','lead','admin'].includes(role));
