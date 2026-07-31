'use client';
// Adapter: the handoff prototype uses lucide icon *names* (<i data-lucide="x"/>).
// The real app uses lucide-react. <Icon name="arrow-right" /> renders the
// matching lucide-react component so prototype markup ports mechanically.
import {
  Search, X, PanelLeftClose, PanelLeftOpen, ArrowRight, ArrowLeft, Plus,
  RefreshCw, FileText, FilePlus, Package, PackageCheck, PackageSearch, Wallet,
  Store, ClipboardList, HandCoins, Boxes, Settings, BookOpen, Shield, Users,
  Building2, Truck, Inbox, BarChart3, ChevronRight, Printer, Pencil, Check,
  CheckCheck, Send, Info, Download, FileSearch, PartyPopper, SearchX, Trash2, Images,
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
};

export function Icon({ name, size = 16, strokeWidth = 1.9, className, style }) {
  const C = MAP[name] || Info;
  return <C size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}
