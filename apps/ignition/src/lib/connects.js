/**
 * Connects vocabulary — Ignition side of the Pitstop→Ignition conversation transfer.
 * Mirrors stages.js three-layer encoding. Channel ownership stays with Pitstop;
 * Ignition reads/replies through ignitionops worker actions.
 */
import { Instagram, MessageCircle, Phone, Mail, Inbox } from 'lucide-react';

export const CHANNEL_VALUES = ['instagram', 'messenger', 'whatsapp', 'email'];

export const CHANNEL_LABELS = {
  instagram: 'Instagram',
  messenger: 'Messenger',
  whatsapp:  'WhatsApp',
  email:     'Email',
};

export const CHANNEL_ICONS = {
  instagram: Instagram,
  messenger: MessageCircle,
  whatsapp:  Phone,
  email:     Mail,
};

// Tone per channel for the badge accent.
export const CHANNEL_PALETTE = {
  instagram: { fg: '#E1306C', bg: 'rgba(225,48,108,0.12)' },
  messenger: { fg: '#7b93ff', bg: 'rgba(123,147,255,0.12)' },
  whatsapp:  { fg: '#25D366', bg: 'rgba(37,211,102,0.12)' },
  email:     { fg: 'var(--text-2, #c9c9c9)', bg: 'var(--surface-2)' },
};

export const STATUS_VALUES = ['new', 'working', 'promoted', 'closed'];

export const STATUS_LABELS = {
  new:      'New',
  working:  'Working',
  promoted: 'Promoted',
  closed:   'Closed',
};

export const STATUS_PALETTE = {
  new:      { fg: '#FF6B00',                 bg: 'rgba(255,107,0,0.12)' },
  working:  { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  promoted: { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  closed:   { fg: 'var(--text-3)',           bg: 'var(--surface-2)' },
};

export { Inbox };
