'use client';
/* ════════════════════════════════════════════════════════════
   Icon — prototype sprite name → lucide-react (handoff §2.5).
   1.75px stroke, currentColor, 16px inline default. Accepts a
   clean name ("alert"), the prototype's sprite id ("i-alert" or
   "#i-alert"), or a Lucide component reference directly.
   ════════════════════════════════════════════════════════════ */
import {
  LayoutDashboard, ListChecks, Phone, BarChart3, Search, Bell, AlertTriangle,
  Clock, PhoneMissed, PhoneIncoming, PhoneOutgoing, RefreshCw, Package, Truck,
  Wrench, MessageSquare, User, Users, Check, X, ExternalLink, Plus, AlarmClock,
  Paperclip, ChevronRight, ChevronLeft, ChevronDown, Zap, Command,
  SlidersHorizontal, Pin, LogOut, Building2, Headphones, Info, CornerDownRight,
  BookOpen,
} from 'lucide-react';

const ICONS = {
  grid: LayoutDashboard, list: ListChecks, phone: Phone, chart: BarChart3,
  search: Search, bell: Bell, alert: AlertTriangle, clock: Clock,
  missed: PhoneMissed, in: PhoneIncoming, out: PhoneOutgoing, refund: RefreshCw,
  box: Package, truck: Truck, wrench: Wrench, msg: MessageSquare, user: User,
  users: Users, check: Check, x: X, ext: ExternalLink, plus: Plus,
  snooze: AlarmClock, paperclip: Paperclip, chevR: ChevronRight, chevL: ChevronLeft,
  chevD: ChevronDown, zap: Zap, cmd: Command, command: Command, cog: SlidersHorizontal,
  settings: SlidersHorizontal, pin: Pin, logout: LogOut, building: Building2,
  headphones: Headphones, info: Info, reply: CornerDownRight, book: BookOpen,
};

function resolve(name) {
  if (!name) return null;
  if (typeof name !== 'string') return name;       // already a component ref
  const key = name.replace(/^#?i-/, '');           // "#i-alert" | "i-alert" | "alert"
  return ICONS[key] || ICONS[name] || null;
}

export function Icon({ name, size = 16, stroke = 1.75, style, color }) {
  const C = resolve(name);
  if (!C) return null;
  return <C size={size} strokeWidth={stroke} style={{ flexShrink: 0, color, ...style }} />;
}
