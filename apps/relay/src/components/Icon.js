'use client';
// Adapter: the handoff prototype uses lucide icon *names* (<i data-lucide="x"/>).
// The real app uses lucide-react. <Icon name="arrow-right" /> renders the
// matching lucide-react component so prototype markup ports mechanically.
//
// ── ICON SIZE SCALE (S296) ────────────────────────────────────────────────
// Three steps, and only three. The app had drifted to ten (11·12·13·14·15·17·18·19·22),
// with 13/14/15 used interchangeably in the same kinds of slot, which is what made icons
// read as subtly misaligned from screen to screen.
//   12  dense chrome — inline affordances in tables, code pills, tight rows
//   14  DEFAULT — buttons, nav, inline-with-text. If unsure, this one.
//   16  emphasis — panel headers, status glyphs that carry meaning on their own
//   (18/22 stay reserved for EmptyState's centred glyph, which is not inline UI.)
// Two deliberate exceptions, both documented at their call site: the WhatsApp and Google
// Messages preview mocks (they simulate somebody else's chrome, same reasoning as their
// hardcoded colours) and the sidebar's own nav-icon role.
import {
  Search, X, PanelLeftClose, PanelLeftOpen, ArrowRight, ArrowLeft, Plus,
  RefreshCw, FileText, FilePlus, Package, PackageCheck, PackageSearch, Wallet,
  Store, ClipboardList, HandCoins, Boxes, Settings, BookOpen, Shield, Users,
  Building2, Truck, Inbox, BarChart3, ChevronRight, Printer, Pencil, Check,
  CheckCheck, Send, Info, Download, FileSearch, PartyPopper, SearchX, Trash2, Images,
  Activity, AlertTriangle, GitBranch, Mail,
} from 'lucide-react';

const MAP = {
  'search': Search, 'x': X, 'panel-left-close': PanelLeftClose, 'panel-left-open': PanelLeftOpen,
  'arrow-right': ArrowRight, 'arrow-left': ArrowLeft, 'plus': Plus, 'refresh-cw': RefreshCw,
  'file-text': FileText, 'file-plus': FilePlus, 'package': Package, 'package-check': PackageCheck,
  'package-search': PackageSearch, 'wallet': Wallet, 'store': Store, 'clipboard-list': ClipboardList,
  'hand-coins': HandCoins, 'boxes': Boxes, 'settings': Settings, 'book-open': BookOpen,
  'shield': Shield, 'users': Users, 'building-2': Building2, 'truck': Truck, 'inbox': Inbox,
  'bar-chart-3': BarChart3, 'chevron-right': ChevronRight, 'printer': Printer, 'pencil': Pencil,
  'check': Check, 'check-check': CheckCheck, 'send': Send, 'info': Info, 'download': Download,
  'file-search': FileSearch, 'party-popper': PartyPopper, 'search-x': SearchX, 'trash-2': Trash2,
  'images': Images,
  // Added S296: these four were REQUESTED by live <EmptyState icon="…"> call sites and
  // absent from the map, so five empty states silently fell back to the generic Info
  // glyph — including an `alert` one, which then read as informational rather than as a
  // problem. A miss is invisible by design (see the fallback below), which is why it
  // survived; if you add an icon= name, add it here too.
  'activity': Activity, 'alert': AlertTriangle, 'git-branch': GitBranch, 'mail': Mail,
};

export function Icon({ name, size = 16, strokeWidth = 1.9, className, style }) {
  const C = MAP[name] || Info;
  return <C size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}
