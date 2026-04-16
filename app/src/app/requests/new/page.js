'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Layout from '@/components/Layout';
import ProductSelector from '@/components/ProductSelector';
import { REQUEST_TYPES, LAUNCH_PACK_ITEMS, getVisibleTypes } from '@/lib/requestTypes';
import { workerFetch } from '@/lib/worker';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export default function NewRequestPage() {
  return (
    <Suspense fallback={<Layout><div style={{ padding: '80px 0', textAlign: 'center' }}><p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>Loading...</p></div></Layout>}>
      <NewRequestContent />
    </Suspense>
  );
}

function NewRequestContent() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [step, setStep] = useState('type'); // 'type' | 'product' | 'checklist' | 'form' | 'review' | 'success'
  const [selectedType, setSelectedType] = useState(null);
  const [title, setTitle] = useState('');
  const [isProductScoped, setIsProductScoped] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [productNotes, setProductNotes] = useState({});
  const [formData, setFormData] = useState({});
  const [checkedItems, setCheckedItems] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [prefillRequest, setPrefillRequest] = useState(null);
  const [isEdit, setIsEdit] = useState(false); // true = info_needed update, false = rejected resubmit

  const visibleTypes = getVisibleTypes(brandUser?.role);

  // Prefill from existing request
  useEffect(() => {
    const prefillId = searchParams?.get('prefill');
    if (prefillId && brandUser) loadPrefill(prefillId);
  }, [brandUser, searchParams]);

  async function loadPrefill(requestId) {
    const { data: req } = await supabase
      .from('requests')
      .select('*, request_products(product_code, product_notes)')
      .eq('id', requestId)
      .single();

    if (!req) return;

    setPrefillRequest(req);
    setIsEdit(req.status === 'info_needed');

    // Find the matching type
    const matchedType = REQUEST_TYPES.find(t => t.id === req.type);
    if (!matchedType) return;

    setSelectedType(matchedType);
    setTitle(req.title);
    setIsProductScoped(req.is_product_scoped);

    // Restore products
    if (req.is_product_scoped && req.request_products?.length > 0) {
      const prods = req.request_products.map(rp => rp.product_code);
      setSelectedProducts(prods);
      const notes = {};
      req.request_products.forEach(rp => {
        if (rp.product_notes) notes[rp.product_code] = rp.product_notes;
      });
      setProductNotes(notes);
    }

    // Restore form data
    if (req.template_data) {
      if (req.type === 'launch_pack' && req.template_data.checklist) {
        setCheckedItems(req.template_data.checklist);
      } else {
        setFormData(req.template_data);
      }
    }

    // Jump to form step
    if (req.type === 'launch_pack') {
      setStep('checklist');
    } else {
      setStep('form');
    }
  }

  // ── Step navigation ────────────────────────────────────────────────────────

  function selectType(type) {
    setSelectedType(type);
    setFormData({});
    setTitle('');
    setIsProductScoped(type.product_required);
    setSelectedProducts([]);
    setProductNotes({});
    // Set defaults for toggle fields
    const defaults = {};
    for (const f of type.fields) {
      if (f.default) defaults[f.id] = f.default;
    }
    setFormData(defaults);
    // Set default checked items for launch pack
    if (type.id === 'launch_pack') {
      setCheckedItems(LAUNCH_PACK_ITEMS.filter(i => i.default_on).map(i => i.id));
    } else {
      setCheckedItems([]);
    }

    // Skip product step for brand_initiative
    if (type.id === 'brand_initiative') {
      setStep('form');
    } else {
      setStep('product');
    }
  }

  function advanceFromProduct() {
    if (selectedType.product_required && selectedProducts.length === 0) {
      setError('Please select at least one product');
      return;
    }
    if (isProductScoped && selectedProducts.length === 0) {
      setError('Please select at least one product');
      return;
    }
    setError(null);
    if (selectedType.id === 'launch_pack') {
      setStep('checklist');
    } else {
      setStep('form');
    }
  }

  function advanceFromChecklist() {
    if (checkedItems.length === 0) {
      setError('Select at least one item for the launch pack');
      return;
    }
    setError(null);
    setStep('review');
  }

  function advanceFromForm() {
    const validationError = validateForm();
    if (validationError) { setError(validationError); return; }
    setError(null);
    setStep('review');
  }

  function toggleItem(itemId) {
    setCheckedItems(prev =>
      prev.includes(itemId) ? prev.filter(i => i !== itemId) : [...prev, itemId]
    );
  }

  function handleFieldChange(fieldId, value) {
    setFormData(prev => ({ ...prev, [fieldId]: value }));
  }

  function toggleMultiSelect(fieldId, opt) {
    setFormData(prev => {
      const current = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
      return {
        ...prev,
        [fieldId]: current.includes(opt) ? current.filter(v => v !== opt) : [...current, opt],
      };
    });
  }

  function isFieldVisible(field) {
    if (!field.conditional) return true;
    return formData[field.conditional.field] === field.conditional.value;
  }

  function validateForm() {
    if (!title.trim()) return 'Request title is required';
    for (const field of selectedType.fields) {
      if (field.required && isFieldVisible(field)) {
        const val = formData[field.id];
        if (!val || (Array.isArray(val) && val.length === 0) || val === '') {
          return `${field.label} is required`;
        }
      }
    }
    return null;
  }

  async function handleSubmit() {
    if (!title.trim()) { setError('Request title is required'); return; }
    setSubmitting(true);
    setError(null);

    const templateData = selectedType.id === 'launch_pack'
      ? { checklist: checkedItems }
      : { ...formData };

    try {
      if (isEdit && prefillRequest) {
        // Info Needed → update same request, back to pending
        await workerFetch('updateRequest', {
          requestId: prefillRequest.id,
          templateData,
        }, session?.access_token);
      } else {
        // New request or rejected resubmit → create new row
        await workerFetch('submitRequest', {
          type: selectedType.id,
          title: title.trim(),
          template_data: templateData,
          is_product_scoped: isProductScoped,
          products: isProductScoped
            ? selectedProducts.map(p => ({ product_name: p, notes: productNotes[p] || '' }))
            : [],
        }, session?.access_token);
      }

      setStep('success');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step: Type selector ────────────────────────────────────────────────────
  if (step === 'type') return (
    <Layout>
      <div style={{ maxWidth: 768, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => router.push('/requests/')}
            style={backBtnStyle}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Back
          </button>
          <h1 style={pageHeadingStyle}>New Request</h1>
          <p style={pageSubStyle}>What type of work do you need?</p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12,
        }}>
          {visibleTypes.map(type => (
            <button
              key={type.id}
              onClick={() => selectType(type)}
              style={{
                background: 'var(--s1)',
                border: '1px solid var(--b1)',
                borderRadius: 6,
                padding: 20,
                textAlign: 'left',
                cursor: 'pointer',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--b3)';
                e.currentTarget.style.background = 'var(--s3)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--b1)';
                e.currentTarget.style.background = 'var(--s1)';
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 10 }}>{type.icon}</div>
              <div style={{ fontFamily: 'var(--head)', fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--text)', marginBottom: 4 }}>
                {type.label}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', lineHeight: 1.5 }}>
                {type.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </Layout>
  );

  // ── Step: Product scoping ──────────────────────────────────────────────────
  if (step === 'product') return (
    <Layout>
      <div style={{ maxWidth: 672, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => { setStep('type'); setError(null); }}
            style={backBtnStyle}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Change type
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>{selectedType.icon}</span>
            <h1 style={pageHeadingStyle}>{selectedType.label}</h1>
          </div>
          <p style={pageSubStyle}>
            {selectedType.product_required
              ? `Select ${selectedType.multi_product ? 'the product(s)' : 'the product'} for this request`
              : 'Is this request for specific products?'}
          </p>
        </div>

        <div style={{
          background: 'var(--s1)',
          border: '1px solid var(--b1)',
          borderRadius: 6,
          padding: 16,
        }}>
          {/* If product is not required, show toggle */}
          {!selectedType.product_required && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: isProductScoped ? 16 : 0,
            }}>
              <div>
                <p style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500, color: 'var(--text)', margin: 0 }}>
                  Product Specific?
                </p>
                <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 2, marginBottom: 0 }}>
                  Is this request for specific products in our range?
                </p>
              </div>
              <ToggleSwitch
                on={isProductScoped}
                onToggle={() => { setIsProductScoped(!isProductScoped); setSelectedProducts([]); }}
              />
            </div>
          )}

          {/* Product selector */}
          {(selectedType.product_required || isProductScoped) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <ProductSelector
                selected={selectedProducts}
                onChange={setSelectedProducts}
                multi={selectedType.multi_product !== false}
              />
              {selectedProducts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                  <p style={sectionLabelStyle}>Add notes per product (optional)</p>
                  {selectedProducts.map(product => (
                    <div key={product}>
                      <label style={fieldLabelStyle}>{product}</label>
                      <InputField
                        value={productNotes[product] || ''}
                        onChange={e => setProductNotes(prev => ({ ...prev, [product]: e.target.value }))}
                        placeholder="Any specific notes for this product..."
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && <ErrorBanner message={error} />}

        <div style={{ display: 'flex', gap: 12, paddingTop: 16 }}>
          <YellowButton onClick={advanceFromProduct} label="Continue" />
          <GhostButton onClick={() => router.push('/requests/')} label="Cancel" />
        </div>
      </div>
    </Layout>
  );

  // ── Step: Launch Pack checklist ────────────────────────────────────────────
  if (step === 'checklist') return (
    <Layout>
      <div style={{ maxWidth: 672, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => { setStep('product'); setError(null); }}
            style={backBtnStyle}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Back
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>{selectedType.icon}</span>
            <h1 style={pageHeadingStyle}>Launch Pack</h1>
          </div>
          <p style={pageSubStyle}>Select the assets needed for this product launch. Each checked item becomes a separate task.</p>
        </div>

        <div style={{
          background: 'var(--s1)',
          border: '1px solid var(--b1)',
          borderRadius: 6,
          padding: '4px 16px',
        }}>
          {LAUNCH_PACK_ITEMS.map(item => (
            <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--b1)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={checkedItems.includes(item.id)}
                onChange={() => toggleItem(item.id)}
                style={{ accentColor: '#F2CD1A', width: 16, height: 16 }}
              />
              <div style={{ flex: 1 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)' }}>{item.label}</span>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em' }}>
                {item.discipline}
              </span>
            </label>
          ))}
        </div>

        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 12 }}>
          {checkedItems.length} item{checkedItems.length !== 1 ? 's' : ''} selected — {checkedItems.length} task{checkedItems.length !== 1 ? 's' : ''} will be created on approval
        </div>

        {error && <ErrorBanner message={error} />}

        {/* Title field before review */}
        <div style={{ marginTop: 20 }}>
          <FormField label="Request Title" required>
            <InputField
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Gyro Flare Launch Pack"
            />
          </FormField>
        </div>

        <div style={{ display: 'flex', gap: 12, paddingTop: 16 }}>
          <YellowButton onClick={advanceFromChecklist} label="Review & Submit" />
          <GhostButton onClick={() => router.push('/requests/')} label="Cancel" />
        </div>
      </div>
    </Layout>
  );

  // ── Step: Template form ────────────────────────────────────────────────────
  if (step === 'form') return (
    <Layout>
      <div style={{ maxWidth: 672, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => {
              setError(null);
              if (selectedType.id === 'brand_initiative') setStep('type');
              else setStep('product');
            }}
            style={backBtnStyle}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Back
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>{selectedType.icon}</span>
            <h1 style={pageHeadingStyle}>{selectedType.label}</h1>
          </div>
          <p style={pageSubStyle}>Fill in the details below</p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Prefill banner */}
          {prefillRequest && (
            <div style={{
              background: isEdit ? 'rgba(242,205,26,0.08)' : 'var(--s2)',
              border: `1px solid ${isEdit ? 'rgba(242,205,26,0.25)' : 'var(--b1)'}`,
              borderRadius: 6,
              padding: '12px 16px',
            }}>
              <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.2em', textTransform: 'uppercase', color: isEdit ? '#F2CD1A' : 'var(--t2)', marginBottom: 4 }}>
                {isEdit ? 'Updating Request' : 'Resubmitting as New Request'}
              </div>
              {prefillRequest.review_note && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', lineHeight: 1.5 }}>
                  Approver noted: &ldquo;{prefillRequest.review_note}&rdquo;
                </div>
              )}
            </div>
          )}

          {/* Title */}
          <FormField label="Request Title" required>
            <InputField
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short description of this request"
            />
          </FormField>

          {/* Dynamic fields */}
          {selectedType.fields.map(field => {
            if (!isFieldVisible(field)) return null;
            return (
              <FormField key={field.id} label={field.label} required={field.required}>
                <FieldInput
                  field={field}
                  value={formData[field.id]}
                  onChange={val => handleFieldChange(field.id, val)}
                  onToggleMulti={(fieldId, opt) => toggleMultiSelect(fieldId, opt)}
                />
              </FormField>
            );
          })}

          {error && <ErrorBanner message={error} />}

          <div style={{ display: 'flex', gap: 12, paddingTop: 8 }}>
            <YellowButton onClick={advanceFromForm} label="Review & Submit" />
            <GhostButton onClick={() => router.push('/requests/')} label="Cancel" />
          </div>
        </div>
      </div>
    </Layout>
  );

  // ── Step: Review & submit ──────────────────────────────────────────────────
  if (step === 'review') return (
    <Layout>
      <div style={{ maxWidth: 672, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => {
              setError(null);
              setStep(selectedType.id === 'launch_pack' ? 'checklist' : 'form');
            }}
            style={backBtnStyle}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Edit
          </button>
          <h1 style={pageHeadingStyle}>Review Request</h1>
          <p style={pageSubStyle}>Confirm the details before submitting</p>
        </div>

        <div style={{
          background: 'var(--s1)',
          border: '1px solid var(--b1)',
          borderRadius: 6,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}>
          {/* Type */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 18 }}>{selectedType.icon}</span>
            <span style={{ fontFamily: 'var(--head)', fontSize: 11, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--t2)' }}>
              {selectedType.label}
            </span>
          </div>

          {/* Title */}
          <div>
            <p style={sectionLabelStyle}>Title</p>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)', margin: 0 }}>{title}</p>
          </div>

          {/* Products */}
          {isProductScoped && selectedProducts.length > 0 && (
            <div>
              <p style={sectionLabelStyle}>Products</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {selectedProducts.map(p => (
                  <span key={p} style={{
                    background: 'var(--s3)',
                    borderRadius: 4,
                    padding: '3px 8px',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--t2)',
                  }}>{p}</span>
                ))}
              </div>
            </div>
          )}

          {/* Launch pack items */}
          {selectedType.id === 'launch_pack' && (
            <div>
              <p style={sectionLabelStyle}>Launch Pack Items ({checkedItems.length})</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {checkedItems.map(itemId => {
                  const item = LAUNCH_PACK_ITEMS.find(i => i.id === itemId);
                  return item ? (
                    <div key={itemId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>{item.label}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase' }}>{item.discipline}</span>
                    </div>
                  ) : null;
                })}
              </div>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#F2CD1A', marginTop: 8, marginBottom: 0 }}>
                {checkedItems.length} task{checkedItems.length !== 1 ? 's' : ''} will be auto-generated on approval
              </p>
            </div>
          )}

          {/* Photo & video note */}
          {selectedType.id === 'photo_video_new' && (
            <div>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#F2CD1A', margin: 0 }}>
                This will create {formData.edit_required === 'Yes' ? '2 tasks: Shoot + Edit' : '1 task: Shoot'}{isProductScoped && selectedProducts.length > 1 ? ` per product (${selectedProducts.length} products)` : ''}
              </p>
            </div>
          )}

          {/* Form data summary */}
          {selectedType.id !== 'launch_pack' && Object.keys(formData).length > 0 && (
            <div>
              <p style={sectionLabelStyle}>Details</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedType.fields.map(field => {
                  if (!isFieldVisible(field)) return null;
                  const val = formData[field.id];
                  if (!val || (Array.isArray(val) && val.length === 0)) return null;
                  return (
                    <div key={field.id} style={{ display: 'flex', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', width: 140, flexShrink: 0 }}>
                        {field.label}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', flex: 1 }}>
                        {Array.isArray(val) ? val.join(', ') : String(val)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {error && <ErrorBanner message={error} />}

        <div style={{ display: 'flex', gap: 12, paddingTop: 16 }}>
          <YellowButton onClick={handleSubmit} label={submitting ? 'Submitting...' : 'Submit Request'} disabled={submitting} />
          <GhostButton onClick={() => router.push('/requests/')} label="Cancel" />
        </div>
      </div>
    </Layout>
  );

  // ── Step: Success ──────────────────────────────────────────────────────────
  if (step === 'success') return (
    <Layout>
      <div style={{ maxWidth: 512, margin: '0 auto', textAlign: 'center', paddingTop: 80, paddingBottom: 80 }}>
        <div style={{ fontSize: 40, marginBottom: 16, color: '#F2CD1A' }}>✓</div>
        <h2 style={{
          fontFamily: 'var(--head)',
          fontWeight: 900,
          fontSize: 16,
          letterSpacing: '.2em',
          textTransform: 'uppercase',
          color: 'var(--text)',
          marginBottom: 8,
        }}>
          Request Submitted
        </h2>
        <p style={{
          fontFamily: 'var(--mono)',
          fontSize: 12,
          color: 'var(--t3)',
          marginBottom: 32,
          lineHeight: 1.6,
        }}>
          Your request has been sent to the brand team for review.
          You&apos;ll be notified once it&apos;s approved or if more information is needed.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            onClick={() => router.push('/requests/')}
            style={{
              background: 'transparent',
              color: 'var(--t2)',
              border: '1px solid var(--b2)',
              borderRadius: 6,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              padding: '10px 24px',
              cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--b3)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--b2)'}
          >
            View My Requests
          </button>
          <button
            onClick={() => {
              setStep('type');
              setSelectedType(null);
              setTitle('');
              setFormData({});
              setCheckedItems([]);
              setIsProductScoped(false);
              setSelectedProducts([]);
              setProductNotes({});
              setError(null);
            }}
            style={{
              background: 'transparent',
              color: 'var(--t2)',
              border: '1px solid var(--b2)',
              borderRadius: 6,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              padding: '10px 24px',
              cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--b3)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--b2)'}
          >
            Submit Another
          </button>
        </div>
      </div>
    </Layout>
  );

  return null;
}

// ── Shared styles ────────────────────────────────────────────────────────────

const backBtnStyle = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--t3)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  marginBottom: 16,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: 0,
};

const pageHeadingStyle = {
  fontFamily: 'var(--head)',
  fontWeight: 900,
  fontSize: 18,
  letterSpacing: '.2em',
  textTransform: 'uppercase',
  color: 'var(--text)',
  margin: 0,
};

const pageSubStyle = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--t3)',
  marginTop: 4,
};

const sectionLabelStyle = {
  fontFamily: 'var(--head)',
  fontSize: 9,
  letterSpacing: '.25em',
  textTransform: 'uppercase',
  color: 'var(--t3)',
  marginBottom: 8,
  marginTop: 0,
};

const fieldLabelStyle = {
  display: 'block',
  fontFamily: 'var(--head)',
  fontSize: 10,
  letterSpacing: '.15em',
  textTransform: 'uppercase',
  color: 'var(--t2)',
  marginBottom: 4,
};

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--s2)',
  border: '1px solid var(--b2)',
  borderRadius: 6,
  padding: '10px 14px',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 13,
  outline: 'none',
};

// ── Reusable components ──────────────────────────────────────────────────────

function InputField({ value, onChange, placeholder, type }) {
  return (
    <input
      type={type || 'text'}
      value={value || ''}
      onChange={onChange}
      placeholder={placeholder}
      style={inputStyle}
      onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
      onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
    />
  );
}

function FormField({ label, required, children }) {
  return (
    <div>
      <label style={{
        display: 'block',
        fontFamily: 'var(--head)',
        fontSize: 10,
        letterSpacing: '.15em',
        textTransform: 'uppercase',
        color: 'var(--t2)',
        marginBottom: 6,
      }}>
        {label}
        {required && <span style={{ color: 'var(--red)', marginLeft: 4 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function ToggleSwitch({ on, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        position: 'relative',
        display: 'inline-flex',
        height: 20,
        width: 36,
        alignItems: 'center',
        borderRadius: 10,
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 0.2s',
        background: on ? '#F2CD1A' : 'var(--s3)',
      }}
    >
      <span style={{
        display: 'inline-block',
        height: 14,
        width: 14,
        borderRadius: 7,
        background: '#080808',
        transition: 'transform 0.2s',
        transform: on ? 'translateX(16px)' : 'translateX(4px)',
      }} />
    </button>
  );
}

function YellowButton({ onClick, label, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: '#F2CD1A',
        color: '#080808',
        fontFamily: 'var(--head)',
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: '.15em',
        textTransform: 'uppercase',
        borderRadius: 6,
        border: 'none',
        padding: '10px 24px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function GhostButton({ onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--t3)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '0 16px',
      }}
      onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
      onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
    >
      {label}
    </button>
  );
}

function ErrorBanner({ message }) {
  return (
    <div style={{
      background: 'rgba(222,42,42,0.08)',
      border: '1px solid rgba(222,42,42,0.3)',
      borderRadius: 8,
      padding: '12px 16px',
      marginTop: 12,
    }}>
      <p style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12, margin: 0 }}>{message}</p>
    </div>
  );
}

function FieldInput({ field, value, onChange, onToggleMulti }) {
  switch (field.type) {
    case 'text':
      return (
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder || ''}
          style={inputStyle}
          onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
        />
      );

    case 'textarea':
      return (
        <textarea
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder || ''}
          style={{ ...inputStyle, resize: 'none', height: 96 }}
          onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
        />
      );

    case 'select':
      return (
        <select
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          style={inputStyle}
          onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
        >
          <option value="">Select...</option>
          {field.options.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );

    case 'multiselect':
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {field.options.map(opt => {
            const selected = Array.isArray(value) && value.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onToggleMulti(field.id, opt)}
                style={{
                  background: selected ? '#F2CD1A' : 'var(--s2)',
                  color: selected ? '#080808' : 'var(--t2)',
                  border: '1px solid var(--b2)',
                  borderRadius: 4,
                  padding: '5px 12px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {opt}
              </button>
            );
          })}
        </div>
      );

    case 'toggle':
      return (
        <div style={{ display: 'flex', gap: 12 }}>
          {field.options.map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              style={{
                padding: '8px 24px',
                borderRadius: 6,
                fontFamily: 'var(--mono)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s',
                background: value === opt ? 'rgba(242,205,26,0.12)' : 'transparent',
                color: value === opt ? '#F2CD1A' : 'var(--t3)',
                border: value === opt ? '1px solid #F2CD1A' : '1px solid var(--b2)',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      );

    case 'date':
      return (
        <input
          type="date"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          style={inputStyle}
          onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
        />
      );

    default:
      return null;
  }
}
