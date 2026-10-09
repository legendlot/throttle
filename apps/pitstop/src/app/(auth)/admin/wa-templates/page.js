'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { ExternalLink, MessageSquare, AlertTriangle, Plus } from 'lucide-react';
import { csopsGet } from '../../../../lib/csopsFetch.js';

// WhatsApp templates are made in RELAY, not here (S412). This page used to edit
// store.cs_wa_templates — local drafts that were never registered with Meta, so a template
// made here could never send (it cost Pruthvi one, #bugs 1791361825.689069). The inbox's
// WhatsApp Template button reads Relay's comms.templates via getWaSendTemplates, so this page
// now shows exactly that list plus where and how to add one.
const RELAY_TEMPLATES_URL = 'https://relay.legendoftoys.com/templates/';
// `preset=support` opens Relay's new-template form already on WhatsApp, the Support account,
// category Utility and a `lot_support_` name (Relay templates/page.js NEW_PRESETS) — Pruthvi asked
// for "create template" to land straight there (#bugs 1791361825.689069).
const RELAY_NEW_SUPPORT_TEMPLATE_URL = `${RELAY_TEMPLATES_URL}?new=1&preset=support`;

export default function WaTemplatesPage() {
  const { perms, session } = useAuth();
  const [tpls, setTpls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!session) return;
    let live = true;
    (async () => {
      setLoading(true);
      try {
        const r = await csopsGet('getWaSendTemplates', {}, session);
        if (live) { setTpls(r || []); setError(null); }
      } catch (e) {
        if (live) setError(e.message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [session]);

  if (!perms?.cs_ticket_admin) return <EmptyState icon="🔒" message="Admin permission required." />;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>WhatsApp Templates</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--t3)', fontSize: 13 }}>
          The templates agents can send from the inbox. They are created and approved in Relay.
        </p>
      </header>

      <section style={{ padding: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-1)', marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>To add a template</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: 'var(--t2)' }}>
          <li>Press <b>Create template in Relay</b> below. It opens a new WhatsApp template already set to the <b>Support</b> account (WABA 1350960337019398) and category <b>Utility</b> — a template on any other account cannot send from the support number.</li>
          <li>Its Meta name must start with <code>lot_support</code> (pre-filled — add the rest, e.g. <code>lot_support_payment_reminder</code>) — anything else is a journey template and will not show up here.</li>
          <li>Submit it to Meta. It appears in the inbox&rsquo;s WhatsApp Template button once Meta approves it.</li>
        </ol>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <a href={RELAY_NEW_SUPPORT_TEMPLATE_URL} target="_blank" rel="noreferrer"
             style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 'var(--radius-sm)',
               background: 'var(--accent)', color: '#000', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
            <Plus size={14} /> Create template in Relay
          </a>
          <a href={RELAY_TEMPLATES_URL} target="_blank" rel="noreferrer"
             style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
            All Relay templates <ExternalLink size={14} />
          </a>
        </div>
      </section>

      <div style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 }}>
        Sendable now{!loading && !error ? ` · ${tpls.length}` : ''}
      </div>
      {loading ? <Spinner /> : error ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--bad-fg)', fontSize: 13 }}>
          <AlertTriangle size={14} /> {error}
        </div>
      ) : tpls.length === 0 ? (
        <EmptyState icon={<MessageSquare size={20} />} message="No approved lot_support templates yet." />
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {tpls.map((t) => (
            <div key={t.id} style={{ padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                <code style={{ fontSize: 12, color: 'var(--t3)' }}>{t.meta_name}</code>
              </div>
              {t.body && (
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--t2)', whiteSpace: 'pre-wrap' }}>{t.body}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
