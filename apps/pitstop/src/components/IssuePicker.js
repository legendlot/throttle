'use client';
import { useEffect, useState } from 'react';
import { fetchIssueCatalog } from '../lib/issueCatalog.js';

const DISPOSITIONS = [
  { value: 'pending',       label: 'Pending' },
  { value: 'query',         label: 'Query' },
  { value: 'no_action',     label: 'No action' },
  { value: 'awaiting_info', label: 'Awaiting info' },
  { value: 'replacement',   label: 'Replacement' },
  { value: 'refund',        label: 'Refund' },
  { value: 'repair',        label: 'Repair' },
];

const selectStyle = {
  background: 'var(--surface)',
  color: 'var(--t1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '9px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  width: '100%',
  outline: 'none',
};

const inputStyle = {
  ...selectStyle,
};

const labelStyle = {
  color: 'var(--t3)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontFamily: 'var(--font-mono)',
  marginBottom: 4,
};

function Field({ label, wide, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gridColumn: wide ? '1 / -1' : 'auto' }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

/**
 * IssuePicker — catalog-driven Category / Sub-category / Disposition controls.
 *
 * Props:
 *   session  — auth session (passed to fetchIssueCatalog)
 *   value    — { issue_category, issue_subcategory, issue_subcategory_custom, disposition }
 *   onChange — function(patchObj) — caller merges patch into form state
 */
export function IssuePicker({ session, value, onChange }) {
  const [catalog, setCatalog] = useState([]); // [{ category, subcategories }]
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchIssueCatalog(session)
      .then(cats => { if (!cancelled) setCatalog(cats || []); })
      .catch(() => { if (!cancelled) setCatalog([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session]);

  if (loading) return null; // show nothing until catalog arrives

  const selectedCat = catalog.find(c => c.category === value.issue_category);
  const subcategories = selectedCat?.subcategories || [];

  // When category is "Other" or no catalog entry found, subcategory dropdown shows only "Other"
  const subcatOptions = value.issue_category === 'Other' ? [] : subcategories;

  const showFreeText =
    value.issue_category === 'Other' || value.issue_subcategory === 'Other';

  function handleCategory(e) {
    const cat = e.target.value;
    onChange({
      issue_category: cat,
      issue_subcategory: '',
      issue_subcategory_custom: '',
    });
  }

  function handleSubcategory(e) {
    onChange({
      issue_subcategory: e.target.value,
      issue_subcategory_custom: '',
    });
  }

  function handleCustom(e) {
    onChange({ issue_subcategory_custom: e.target.value });
  }

  function handleDisposition(e) {
    onChange({ disposition: e.target.value });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Row 1: Category / Sub-category / Disposition */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 12,
      }}>
        <Field label="Category">
          <select value={value.issue_category || ''} onChange={handleCategory} style={selectStyle}>
            <option value="">— select —</option>
            {catalog.map(c => (
              <option key={c.category} value={c.category}>{c.category}</option>
            ))}
            <option value="Other">Other</option>
          </select>
        </Field>

        <Field label="Sub-category">
          <select
            value={value.issue_subcategory || ''}
            onChange={handleSubcategory}
            disabled={!value.issue_category}
            style={{
              ...selectStyle,
              opacity: !value.issue_category ? 0.45 : 1,
              cursor: !value.issue_category ? 'not-allowed' : 'default',
            }}
          >
            <option value="">— select —</option>
            {subcatOptions.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="Other">Other</option>
          </select>
        </Field>

        <Field label="Disposition">
          <select value={value.disposition || 'pending'} onChange={handleDisposition} style={selectStyle}>
            {DISPOSITIONS.map(d => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Row 2: Free-text, only when Other is selected */}
      {showFreeText && (
        <Field label="Describe the issue (Other)" wide>
          <input
            type="text"
            value={value.issue_subcategory_custom || ''}
            onChange={handleCustom}
            placeholder="Briefly describe the issue…"
            style={inputStyle}
          />
        </Field>
      )}
    </div>
  );
}
