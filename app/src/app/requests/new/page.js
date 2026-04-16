'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import ProductSelector from '@/components/ProductSelector';
import { REQUEST_TYPES, REQUEST_TEMPLATES } from '@/lib/requestTypes';
import { workerFetch } from '@/lib/worker';
import { useAuth } from '@/lib/auth';

export default function NewRequestPage() {
  const { session } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState('type'); // 'type' | 'form' | 'success'
  const [selectedType, setSelectedType] = useState(null);
  const [title, setTitle] = useState('');
  const [isProductScoped, setIsProductScoped] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [productNotes, setProductNotes] = useState({}); // { productName: note }
  const [formData, setFormData] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function selectType(type) {
    setSelectedType(type);
    setStep('form');
    setFormData({});
    setTitle('');
    setIsProductScoped(false);
    setSelectedProducts([]);
    setProductNotes({});
  }

  function handleFieldChange(key, value) {
    setFormData(prev => ({ ...prev, [key]: value }));
  }

  function handleProductNoteChange(product, note) {
    setProductNotes(prev => ({ ...prev, [product]: note }));
  }

  function isFieldVisible(field) {
    if (!field.conditional) return true;
    return formData[field.conditional.key] === field.conditional.value;
  }

  function validate() {
    if (!title.trim()) return 'Request title is required';
    const fields = REQUEST_TEMPLATES[selectedType.value] || [];
    for (const field of fields) {
      if (field.required && isFieldVisible(field)) {
        const val = formData[field.key];
        if (!val || (Array.isArray(val) && val.length === 0) || val === '') {
          return `${field.label} is required`;
        }
      }
    }
    if (isProductScoped && selectedProducts.length === 0) {
      return 'Please select at least one product';
    }
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setSubmitting(true);
    setError(null);

    try {
      await workerFetch('submitRequest', {
        type: selectedType.value,
        title: title.trim(),
        template_data: formData,
        is_product_scoped: isProductScoped,
        products: isProductScoped
          ? selectedProducts.map(p => ({ product_name: p, notes: productNotes[p] || '' }))
          : [],
      }, session?.access_token);

      setStep('success');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step: Type selector ─────────────────────────────────────────────────────
  if (step === 'type') return (
    <Layout>
      <div style={{ maxWidth: 672, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => router.push('/requests/')}
            style={{
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
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Back
          </button>
          <h1 style={{
            fontFamily: 'var(--head)',
            fontWeight: 900,
            fontSize: 18,
            letterSpacing: '.2em',
            textTransform: 'uppercase',
            color: 'var(--text)',
            margin: 0,
          }}>
            New Request
          </h1>
          <p style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--t3)',
            marginTop: 4,
          }}>
            What type of work do you need?
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}>
          {REQUEST_TYPES.map(type => (
            <button
              key={type.value}
              onClick={() => selectType(type)}
              style={{
                background: 'var(--s1)',
                border: '1px solid var(--b1)',
                borderRadius: 6,
                padding: 16,
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
              <div style={{ fontSize: 24, marginBottom: 8 }}>{type.icon}</div>
              <div style={{
                fontFamily: 'var(--mono)',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--text)',
              }}>
                {type.label}
              </div>
            </button>
          ))}
        </div>
      </div>
    </Layout>
  );

  // ── Step: Success ───────────────────────────────────────────────────────────
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
            onClick={() => setStep('type')}
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

  // ── Step: Form ──────────────────────────────────────────────────────────────
  const fields = REQUEST_TEMPLATES[selectedType?.value] || [];

  return (
    <Layout>
      <div style={{ maxWidth: 672, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => setStep('type')}
            style={{
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
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t2)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >
            ← Change type
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>{selectedType.icon}</span>
            <h1 style={{
              fontFamily: 'var(--head)',
              fontWeight: 900,
              fontSize: 18,
              letterSpacing: '.2em',
              textTransform: 'uppercase',
              color: 'var(--text)',
              margin: 0,
            }}>
              {selectedType.label}
            </h1>
          </div>
          <p style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--t3)',
          }}>
            Fill in the details below
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Title */}
          <FormField label="Request Title" required>
            <InputField
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short description of this request"
            />
          </FormField>

          {/* Product scoping */}
          <div style={{
            background: 'var(--s1)',
            border: '1px solid var(--b1)',
            borderRadius: 6,
            padding: 16,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}>
              <div>
                <p style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--text)',
                  margin: 0,
                }}>
                  Product Specific?
                </p>
                <p style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--t3)',
                  marginTop: 2,
                  marginBottom: 0,
                }}>
                  Is this request for specific products in our range?
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsProductScoped(!isProductScoped);
                  setSelectedProducts([]);
                }}
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
                  background: isProductScoped ? '#F2CD1A' : 'var(--s3)',
                }}
              >
                <span style={{
                  display: 'inline-block',
                  height: 14,
                  width: 14,
                  borderRadius: 7,
                  background: '#080808',
                  transition: 'transform 0.2s',
                  transform: isProductScoped ? 'translateX(16px)' : 'translateX(4px)',
                }} />
              </button>
            </div>

            {isProductScoped && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ProductSelector
                  selected={selectedProducts}
                  onChange={setSelectedProducts}
                />
                {selectedProducts.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                    <p style={{
                      fontFamily: 'var(--head)',
                      fontSize: 9,
                      letterSpacing: '.2em',
                      textTransform: 'uppercase',
                      color: 'var(--t3)',
                      margin: 0,
                    }}>
                      Add notes per product (optional)
                    </p>
                    {selectedProducts.map(product => (
                      <div key={product}>
                        <label style={{
                          fontFamily: 'var(--head)',
                          fontSize: 10,
                          letterSpacing: '.15em',
                          textTransform: 'uppercase',
                          color: 'var(--t2)',
                          marginBottom: 4,
                          display: 'block',
                        }}>
                          {product}
                        </label>
                        <InputField
                          type="text"
                          placeholder="Any specific notes for this product..."
                          value={productNotes[product] || ''}
                          onChange={e => handleProductNoteChange(product, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Template fields */}
          {fields.map(field => {
            if (!isFieldVisible(field)) return null;
            return (
              <FormField key={field.key} label={field.label} required={field.required}>
                <FieldInput
                  field={field}
                  value={formData[field.key]}
                  onChange={val => handleFieldChange(field.key, val)}
                />
              </FormField>
            );
          })}

          {/* Error */}
          {error && (
            <div style={{
              background: 'rgba(222,42,42,0.08)',
              border: '1px solid rgba(222,42,42,0.3)',
              borderRadius: 8,
              padding: '12px 16px',
            }}>
              <p style={{
                color: 'var(--red)',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                margin: 0,
              }}>{error}</p>
            </div>
          )}

          {/* Submit */}
          <div style={{ display: 'flex', gap: 12, paddingTop: 8 }}>
            <button
              onClick={handleSubmit}
              disabled={submitting}
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
                cursor: submitting ? 'default' : 'pointer',
                opacity: submitting ? 0.5 : 1,
              }}
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
            <button
              onClick={() => router.push('/requests/')}
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
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Layout>
  );
}

// ── Helper components ─────────────────────────────────────────────────────────

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

const textareaStyle = {
  ...inputStyle,
  resize: 'none',
  height: 96,
};

const selectStyle = {
  ...inputStyle,
};

function InputField({ type, value, onChange, placeholder }) {
  return (
    <input
      type={type || 'text'}
      value={value}
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

function FieldInput({ field, value, onChange }) {
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
          style={textareaStyle}
          onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
        />
      );

    case 'select':
      return (
        <select
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          style={selectStyle}
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
                onClick={() => {
                  const current = Array.isArray(value) ? value : [];
                  onChange(selected ? current.filter(v => v !== opt) : [...current, opt]);
                }}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  padding: '6px 12px',
                  borderRadius: 20,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  background: selected ? 'rgba(242,205,26,0.12)' : 'transparent',
                  color: selected ? '#F2CD1A' : 'var(--t3)',
                  border: selected ? '1px solid #F2CD1A' : '1px solid var(--b2)',
                }}
              >
                {opt}
              </button>
            );
          })}
        </div>
      );

    case 'yesno':
      return (
        <div style={{ display: 'flex', gap: 12 }}>
          {['yes', 'no'].map(opt => (
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
              {opt === 'yes' ? 'Yes' : 'No'}
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
          style={selectStyle}
          onFocus={e => e.currentTarget.style.borderColor = '#F2CD1A'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--b2)'}
        />
      );

    default:
      return null;
  }
}
