'use client';
import { useEffect, useState } from 'react';
import { ignitionopsGet, ignitionopsPost } from './ignitionopsFetch.js';
import { emptyLine, linesToPayload, linesAreValid } from '../components/ProductLinesEditor.js';
import { initialDealForm, dealPayload, isPaidDeal, isAffiliateDeal } from './dealPayload.js';

// New-deal form state for BOTH surfaces — the /engagements/new page and NewDealModal (P0.3, S412).
// State, campaign list and the create call live here; each surface keeps only its
// own layout and what happens after create (the page routes to the deal, the modal closes and calls
// `onCreated` or routes). `active` gates the campaign fetch so a page that never opens the modal pays
// nothing (it used to load only once the modal opened).
export function useDealForm({ session, active = true, presetInfluencer = null, initial = {} }) {
  const [form, setForm] = useState(() => initialDealForm(initial));
  const [selected, setSelected] = useState(presetInfluencer || null);
  const [lines, setLines] = useState([emptyLine()]);
  const [productsValid, setProductsValid] = useState(true);
  const [campaigns, setCampaigns] = useState([]);
  const [busy, setBusy] = useState(false);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isPaid = isPaidDeal(form.deal_type);
  const isAffiliate = isAffiliateDeal(form.deal_type);

  // Reann #3 (S273) — a real campaign, not a typed tag.
  function loadCampaigns() {
    if (!session || !active) return;
    ignitionopsGet('getCampaigns', { status: 'active' }, session)
      .then(r => setCampaigns(r.campaigns || []))
      .catch(() => setCampaigns([]));
  }
  useEffect(loadCampaigns, [session, active]);

  // The influencer search lives in <InfluencerPicker> (components/NewDealModal.js) — Typeahead owns its
  // debounce/abort/stale guard; this hook only holds the pick.
  function pick(r) { setSelected(r); }

  /** Returns a user-facing reason the deal can't be created yet, or null. */
  function problem() {
    if (!selected) return 'Pick an influencer first';
    // Every product line must resolve to a real catalogue product (2026-09-04). The button is
    // disabled too — this is the guard that holds if a blur lands in the same tick as the click.
    if (!productsValid || !linesAreValid(lines)) return 'Pick a product from the list for every line';
    return null;
  }

  /** Creates the deal; resolves to the worker's { id, engagement_no } or throws. */
  async function create() {
    setBusy(true);
    try {
      return await ignitionopsPost('createEngagement', dealPayload(form, selected.id, linesToPayload(lines)), session);
    } finally { setBusy(false); }
  }

  return {
    form, setForm, setField, isPaid, isAffiliate,
    selected, setSelected, pick,
    lines, setLines, productsValid, setProductsValid,
    campaigns, loadCampaigns,
    busy, problem, create,
  };
}
