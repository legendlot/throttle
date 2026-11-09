// Snorkel (procurement, sales orders, assets) tools: READ-ONLY, as the person (their own Supabase JWT,
// service binding SNORKELOPS). Afshaan 2026-11-09 asked for Snorkel; the standing exclusion holds
// (decisions §Team MCP gateway): NO payment module data (requests, payees, banks, finance queue, payment
// docs), NO vendor/partner/forwarder contact details or addresses, NO role/user admin, NO diag/export.
//
// ⚠️ Gating is the GATEWAY's job here: snorkelops' GET switch only requires a users_profile role, and
// many reads (stock, vendors list rights aside, BOM, requests, forwarders) check no Snorkel permission at
// all. So each tool is hidden and refused unless the person's Snorkel role (store.mcp_gate snorkel_perms)
// holds the permission the Snorkel app gates that screen on, with snorkelops' own truthiness.
import { T, reportTool } from './build.js';

const sp = g => (g && g.snorkel_perms && typeof g.snorkel_perms === 'object') ? g.snorkel_perms : {};
// snorkelops index.js:36/47/50, verbatim rules.
const canView = g => !!sp(g).procurement_view;
const canViewAssets = g => !!sp(g).asset_view || !!sp(g).asset_manage;
const canSalesView = g => { const p = sp(g); return !!p.sales_view || !!p.sales_order_manage || !!p.sales_order_confirm || !!p.sales_payment_manage || !!p.sales_partner_manage; };
const anyRole = g => Object.values(sp(g)).some(Boolean);
// Finer, per-screen gates, exactly as apps/snorkel shows them (lib/nav.js; sales/*/page.js).
const has = (...keys) => g => keys.some(k => !!sp(g)[k]);
const vendorScreens = has('vendor_manage');                                       // nav: Vendors, Forwarders
const salesOrders = has('sales_view', 'sales_order_manage', 'sales_partner_manage'); // orders, partners pages
const partyBalances = has('sales_view', 'sales_order_manage', 'sales_payment_manage');
const creditNotes = has('sales_view', 'sales_credit_note');
const channelScreen = has('sales_partner_manage');                                 // sales/settings page
const need = (fn, reason) => g => (fn(g) ? null : reason);

// Dropped wherever they appear, at any depth (reviews 2026-11-09):
//  - contact details, addresses, bank fields, payment-module fields;
//  - sales `payments` (receipts with UTR/cheque references) and PO revision `snapshot`s (JSON text that
//    would carry old payment fields past the key filter);
//  - ALL free text (notes, details, reasons, references, tracking links): it is where contacts and bank
//    details get typed, and it is the prompt-injection surface. Plus LOT user ids (`dropIds`).
// ⚠️ A deny-list, not the per-field allowlist the design asked for: accepted because free text is dropped
// wholesale; a NEW contact-like column must be added here (snorkel test pins the known ones).
const SNORKEL_DROP = /^(contact_|phone|mobile|email|address|billing_address|shipping_address|pincode|udyam_number)|_(phone|email|mobile)$|bank|ifsc|account_n|upi|swift|iban|^paid_by$|^payment_(note|requested_by|routed_to)$|_user_id$|^(payments|snapshot|notes?|details|remarks|reference|tracking_url|description_internal)$|_(note|notes|reason|remarks)$/i;
const COMMON = { system: 'snorkel', binding: 'SNORKELOPS', scrubEmails: true, dropMatch: SNORKEL_DROP, dropIds: true, reportDenied: 'snorkel denied' };
// Catalogue-sized reads (material_current ~2,800 rows) must be narrowed, or the cap hides most parts.
const search = (d, p) => {
  const rows = Array.isArray(d) ? d : [];
  const q = (p.q || '').toLowerCase();
  const out = rows.filter(r => (!p.part_code || String(r.part_code || '').toLowerCase() === p.part_code.toLowerCase())
    && (!p.part_category || String(r.part_category ?? r.category ?? '').toLowerCase() === p.part_category.toLowerCase())
    && (!q || `${r.part_code || ''} ${r.part_name || ''}`.toLowerCase().includes(q)));
  return { rows: out, count: out.length };
};
const needFilter = keys => p => (keys.some(k => p[k]) ? null : `give one of: ${keys.join(', ')} (the full list is too long to return)`);
const flag1 = { schema: { type: 'boolean' }, check: v => typeof v === 'boolean' ? { ok: true, value: v ? '1' : '0' } : { ok: false, error: 'must be true or false' } };
const pickBy = (keys) => (d, p) => {
  const rows = Array.isArray(d) ? d : [];
  const want = keys.filter(k => p && p[k]);
  const out = want.length ? rows.filter(r => want.every(k => String(r[k] ?? '').toLowerCase() === String(p[k]).toLowerCase())) : rows;
  return { rows: out, count: out.length };
};

const snorkelTools = [
  reportTool({
    ...COMMON, name: 'snorkel_procurement', title: 'Snorkel procurement', visible: canView, deny: need(canView, 'snorkel denied'),
    description: 'Read Snorkel procurement: purchase orders (list, or one in full), vendors and forwarders (vendor managers only; no contact details), stock ledger, materials and parts (search), moulds, BOMs, the product catalogue, HSN rates and reorder requests. Snorkel hides China PO money from roles without China access. Notes and other free text are not included.',
    paramAbout: { status: 'Filter by status.', source: 'PO source, e.g. China / Domestic.', order_type: 'PO order type.', po_number: 'The PO number.', vendor_code: 'Vendor code (from report=vendors).', product: 'Product code.', part_code: 'Part code (exact).', part_category: 'Part category (exact).', q: 'Search text in part code or name.', po_category: 'PO category (required for vendors_for_product).', mould_no: 'Mould number.' },
    reports: {
      pos: { action: 'getPOs', about: 'purchase orders (most recent first, capped)', params: { status: T.text, source: T.text, order_type: T.text } },
      po: { action: 'getPO', about: 'one PO in full with its lines', params: { po_number: T.code }, required: ['po_number'] },
      vendors: { action: 'getVendors', allow: vendorScreens, about: 'vendors (vendor managers only; no contacts or addresses)', params: { active: T.oneOf('true', 'false'), source_country: T.text } },
      vendor: { action: 'getVendor', allow: vendorScreens, about: 'one vendor (vendor managers only)', params: { vendor_code: T.code }, required: ['vendor_code'] },
      vendor_items: { action: 'getVendorSuppliedItems', allow: vendorScreens, about: 'what one vendor supplies (vendor managers only)', params: { vendor_code: T.code }, required: ['vendor_code'] },
      vendors_for_product: { action: 'getVendorsForProduct', allow: vendorScreens, about: 'vendors for a product or part in one PO category (vendor managers only)', params: { product: T.code, part_code: T.code, po_category: T.text }, required: ['po_category'] },
      forwarders: { action: 'getForwarders', allow: vendorScreens, about: 'freight forwarders (vendor managers only; no contacts)', params: {} },
      stock: { action: 'getStock', about: 'stock ledger per part; filter by product or part_code', params: { product: T.code, part_code: T.code }, shape: pickBy(['product', 'part_code']) },
      materials: { action: 'getMaterials', about: 'search the material master (give q, part_code or part_category)', params: { q: T.text, part_code: T.code, part_category: T.text }, check: needFilter(['q', 'part_code', 'part_category']), shape: search },
      parts: { action: 'getProcurementParts', about: 'search the orderable part catalogue (give q, part_code or part_category)', params: { q: T.text, part_code: T.code, part_category: T.text }, check: needFilter(['q', 'part_code', 'part_category']), shape: search },
      bom: { action: 'getBOM', about: 'bill of materials for one product', params: { product: T.code }, required: ['product'] },
      catalogue: { action: 'getProductCatalogue', about: 'the product catalogue', params: {} },
      moulds: { action: 'getMoulds', about: 'the mould register', params: {} },
      mould: { action: 'getMould', about: 'one mould', params: { mould_no: T.code }, required: ['mould_no'] },
      hsn_rates: { action: 'getHsnRates', about: 'HSN codes and GST rates', params: {} },
      reorder: { action: 'getReorderRequests', about: 'reorder requests', params: { status: T.text, urgency: T.text } },
    },
  }),
  reportTool({
    ...COMMON, name: 'snorkel_requests', title: 'Snorkel purchase requests', visible: anyRole, deny: need(anyRole, 'snorkel denied'),
    description: 'Read Snorkel purchase requests (the queue anyone with a Snorkel role can see): the list, or one request in full.',
    paramAbout: { status: 'Filter by status.', mine: 'Only requests you raised.', request_no: 'The request number.' },
    reports: {
      requests: { action: 'getRequests', about: 'purchase requests (latest 300)', params: { status: T.text, mine: flag1 } },
      request: { action: 'getRequest', about: 'one request with its lines', params: { request_no: T.code }, required: ['request_no'] },
    },
  }),
  reportTool({
    ...COMMON, name: 'snorkel_sales', title: 'Snorkel sales orders', visible: canSalesView, deny: need(canSalesView, 'snorkel denied'),
    description: 'Read Snorkel B2B sales: sales orders, party balances, credit notes, sales channels and partners (no contacts, addresses, payment receipts or notes). Each report follows the Snorkel screen\'s own access rule.',
    paramAbout: { status: 'Filter by status.', channel_key: 'Sales channel key (from report=channels).', partner_id: 'Partner id (from report=partners).', id: 'The record id.', order_id: 'Sales order id.' },
    reports: {
      orders: { action: 'getSalesOrders', allow: salesOrders, about: 'sales orders', params: { status: T.text, channel_key: T.code, partner_id: T.uuid } },
      order: { action: 'getSalesOrder', allow: salesOrders, about: 'one sales order with its lines (payment receipts not included)', params: { id: T.uuid }, required: ['id'] },
      party_balances: { action: 'getSalesPartyBalances', allow: partyBalances, about: 'outstanding balance per partner', params: {} },
      credit_notes: { action: 'getCreditNotes', allow: creditNotes, about: 'credit notes', params: { status: T.text, order_id: T.uuid, partner_id: T.uuid } },
      credit_note: { action: 'getCreditNote', allow: creditNotes, about: 'one credit note', params: { id: T.uuid }, required: ['id'] },
      channels: { action: 'getSalesChannels', allow: channelScreen, about: 'sales channels (sales partner managers)', params: {} },
      partners: { action: 'getSalesPartners', allow: salesOrders, about: 'sales partners (no contacts or addresses)', params: { channel_key: T.code, active: flag1 } },
      partner: { action: 'getSalesPartner', allow: salesOrders, about: 'one sales partner (no contacts or addresses)', params: { id: T.uuid }, required: ['id'] },
    },
  }),
  reportTool({
    ...COMMON, name: 'snorkel_assets', title: 'Snorkel asset register', visible: canViewAssets, deny: need(canViewAssets, 'snorkel denied'),
    description: 'Read the Snorkel asset register: assets (filterable), one asset, categories and locations. No document downloads.',
    paramAbout: { status: 'Filter by status.', category_id: 'Category id (from report=categories).', location_id: 'Location id (from report=locations).', acquisition_type: 'e.g. purchased / rented.', id: 'Asset id.' },
    reports: {
      assets: { action: 'getAssets', about: 'assets', params: { status: T.text, category_id: T.int(1, 1000000), location_id: T.int(1, 1000000), acquisition_type: T.text } },
      asset: { action: 'getAsset', about: 'one asset in full', params: { id: T.uuid }, required: ['id'] },
      categories: { action: 'getAssetCategories', about: 'asset categories', params: {} },
      locations: { action: 'getAssetLocations', about: 'asset locations', params: {} },
    },
  }),
];
export default snorkelTools;
