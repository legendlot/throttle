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
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <button
            onClick={() => router.push('/requests/')}
            className="text-zinc-600 text-sm hover:text-zinc-400 transition-colors mb-4 flex items-center gap-1"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-bold text-white">New Request</h1>
          <p className="text-zinc-500 text-sm mt-1">What type of work do you need?</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {REQUEST_TYPES.map(type => (
            <button
              key={type.value}
              onClick={() => selectType(type)}
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-left hover:border-zinc-600 hover:bg-zinc-800 transition-all group"
            >
              <div className="text-2xl mb-2">{type.icon}</div>
              <div className="text-sm font-medium text-zinc-200 group-hover:text-white">
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
      <div className="max-w-lg mx-auto text-center py-20">
        <div className="text-4xl mb-4">✓</div>
        <h2 className="text-xl font-bold text-white mb-2">Request Submitted</h2>
        <p className="text-zinc-500 text-sm mb-8">
          Your request has been sent to the brand team for review.
          You&apos;ll be notified once it&apos;s approved or if more information is needed.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => router.push('/requests/')}
            className="bg-white text-black font-semibold px-6 py-2.5 rounded-lg text-sm hover:bg-zinc-100 transition-colors"
          >
            View My Requests
          </button>
          <button
            onClick={() => setStep('type')}
            className="bg-zinc-800 text-zinc-200 font-medium px-6 py-2.5 rounded-lg text-sm hover:bg-zinc-700 transition-colors"
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
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <button
            onClick={() => setStep('type')}
            className="text-zinc-600 text-sm hover:text-zinc-400 transition-colors mb-4 flex items-center gap-1"
          >
            ← Change type
          </button>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">{selectedType.icon}</span>
            <h1 className="text-2xl font-bold text-white">{selectedType.label}</h1>
          </div>
          <p className="text-zinc-500 text-sm">Fill in the details below</p>
        </div>

        <div className="space-y-5">
          {/* Title */}
          <FormField label="Request Title" required>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short description of this request"
              className={inputCls}
            />
          </FormField>

          {/* Product scoping */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-zinc-200">Product Specific?</p>
                <p className="text-xs text-zinc-600 mt-0.5">
                  Is this request for specific products in our range?
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsProductScoped(!isProductScoped);
                  setSelectedProducts([]);
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  isProductScoped ? 'bg-white' : 'bg-zinc-700'
                }`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-black transition-transform ${
                  isProductScoped ? 'translate-x-4' : 'translate-x-1'
                }`} />
              </button>
            </div>

            {isProductScoped && (
              <div className="mt-3 space-y-3">
                <ProductSelector
                  selected={selectedProducts}
                  onChange={setSelectedProducts}
                />
                {selectedProducts.length > 0 && (
                  <div className="space-y-2 mt-3">
                    <p className="text-xs text-zinc-600">
                      Add notes per product (optional)
                    </p>
                    {selectedProducts.map(product => (
                      <div key={product}>
                        <label className="text-xs text-zinc-500 mb-1 block">{product}</label>
                        <input
                          type="text"
                          placeholder="Any specific notes for this product..."
                          value={productNotes[product] || ''}
                          onChange={e => handleProductNoteChange(product, e.target.value)}
                          className={inputCls}
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
            <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-white text-black font-semibold px-6 py-2.5 rounded-lg text-sm hover:bg-zinc-100 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
            <button
              onClick={() => router.push('/requests/')}
              className="text-zinc-600 text-sm hover:text-zinc-400 transition-colors px-4"
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

const inputCls = "w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500";
const textareaCls = "w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none h-24";
const selectCls = "w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500";

function FormField({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
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
          className={inputCls}
        />
      );

    case 'textarea':
      return (
        <textarea
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder || ''}
          className={textareaCls}
        />
      );

    case 'select':
      return (
        <select
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          className={selectCls}
        >
          <option value="">Select...</option>
          {field.options.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );

    case 'multiselect':
      return (
        <div className="flex flex-wrap gap-2">
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
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  selected
                    ? 'bg-white text-black border-white'
                    : 'bg-transparent text-zinc-400 border-zinc-700 hover:border-zinc-500'
                }`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      );

    case 'yesno':
      return (
        <div className="flex gap-3">
          {['yes', 'no'].map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`px-6 py-2 rounded-lg text-sm font-medium border transition-colors ${
                value === opt
                  ? 'bg-white text-black border-white'
                  : 'bg-transparent text-zinc-400 border-zinc-700 hover:border-zinc-500'
              }`}
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
          className={selectCls}
        />
      );

    default:
      return null;
  }
}
