'use client';
// UI kit gallery (ClickUp redesign P0) — every ui/ primitive in every
// variant / size / state, for smoke-testing. Not linked from nav: /ui-kit/.
import { useRef, useState } from 'react';
import {
  Plus, Pencil, Trash2, Copy, Archive, Star, Filter, Settings, Search,
  User, Calendar, Flag, FolderKanban, Inbox, List, Kanban, CalendarDays,
} from 'lucide-react';
import {
  Button, IconButton, SplitButton, Pill, Tooltip, Kbd,
  Menu, MenuItem, MenuSeparator, MenuLabel, AvatarStack, GhostCell, SegmentedTabs, EmptyState,
} from '../../../components/ui/index.js';

const VARIANTS = ['primary', 'neutral', 'ghost', 'danger'];
const SIZES = ['sm', 'md', 'lg'];
const PEOPLE = ['Afshaan Siddiqui', 'Pruthvi Shah', 'Joseph Dsouza', 'Reann Pinto', 'Meera Rao', 'Kabir Nair'];

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: 'var(--f-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>{title}</h2>
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 16 }}>{children}</div>
    </section>
  );
}
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
      <span style={{ width: 110, fontSize: 12, color: 'var(--text-3)' }}>{label}</span>
      {children}
    </div>
  );
}

export default function UiKitPage() {
  const [tab, setTab] = useState('list');
  const [menuOpen, setMenuOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [last, setLast] = useState('—');
  const menuAnchor = useRef(null);
  const splitAnchor = useRef(null);

  return (
    <div style={{ padding: '24px 28px 60px', overflowY: 'auto', height: '100%', fontFamily: 'var(--f-ui)' }}>
      <h1 style={{ fontFamily: 'var(--f-brand)', fontSize: 20, fontWeight: 600, marginBottom: 4 }}>UI kit</h1>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 24 }}>
        Docket redesign P0 primitives. Last action: <span style={{ color: 'var(--text-1)' }}>{last}</span>
      </p>

      <Section title="Button — variant × size">
        {VARIANTS.map(v => (
          <Row key={v} label={v}>
            {SIZES.map(s => <Button key={s} variant={v} size={s} icon={Plus} onClick={() => setLast(`${v} ${s}`)}>Task</Button>)}
            <Button variant={v} iconRight={Filter}>Icon right</Button>
            <Button variant={v} loading>Saving</Button>
            <Button variant={v} disabled>Disabled</Button>
            <Button variant={v} icon={Star} aria-label="Icon only" />
          </Row>
        ))}
      </Section>

      <Section title="IconButton — size × variant (hover for tooltip)">
        {['ghost', 'neutral'].map(v => (
          <Row key={v} label={v}>
            {SIZES.map(s => <IconButton key={s} variant={v} size={s} icon={Settings} label={`Settings (${s})`} />)}
            <IconButton variant={v} icon={Search} label="Search" shortcut={['⌘', 'K']} />
            <IconButton variant={v} icon={Filter} label="Filter (active)" active />
            <IconButton variant={v} icon={Trash2} label="Delete (disabled)" disabled />
          </Row>
        ))}
      </Section>

      <Section title="SplitButton">
        {['primary', 'neutral'].map(v => (
          <Row key={v} label={v}>
            {SIZES.map(s => (
              <SplitButton key={s} variant={v} size={s} icon={Plus} onMain={() => setLast(`split main ${v} ${s}`)}
                menuRef={v === 'primary' && s === 'md' ? splitAnchor : undefined}
                onMenu={() => (v === 'primary' && s === 'md' ? setSplitOpen(o => !o) : setLast(`split menu ${v} ${s}`))}>Task</SplitButton>
            ))}
            <SplitButton variant={v} icon={Plus} disabled>Disabled</SplitButton>
          </Row>
        ))}
        <Menu anchorRef={splitAnchor} open={splitOpen} onClose={() => setSplitOpen(false)} label="Create">
          <MenuItem icon={Plus} onClick={() => setLast('create task')}>Task</MenuItem>
          <MenuItem icon={Copy} onClick={() => setLast('from template')}>From template</MenuItem>
        </Menu>
      </Section>

      <Section title="Pill">
        <Row label="neutral">
          <Pill>No lead</Pill>
          <Pill dot>Dot</Pill>
          <Pill icon={Flag}>Icon</Pill>
          <Pill icon={FolderKanban}>Program name that is long</Pill>
        </Row>
        <Row label="status">
          <Pill tone="status" color="var(--st-todo)" dot>To do</Pill>
          <Pill tone="status" color="var(--st-progress)" dot>In progress</Pill>
          <Pill tone="status" color="var(--st-blocked)" dot>Blocked</Pill>
          <Pill tone="status" color="var(--st-done)" dot>Done</Pill>
          <Pill tone="status" color="var(--st-abandon)" dot>Abandoned</Pill>
        </Row>
        <Row label="priority">
          <Pill tone="status" color="var(--p0)" icon={Flag}>P0</Pill>
          <Pill tone="status" color="var(--p1)" icon={Flag}>P1</Pill>
          <Pill tone="status" color="var(--p2)" icon={Flag}>P2</Pill>
          <Pill tone="status" color="#e15ad8">Hex colour</Pill>
        </Row>
      </Section>

      <Section title="Tooltip + Kbd">
        <Row label="tooltip">
          <Tooltip content="Plain tooltip"><Button>Hover me</Button></Tooltip>
          <Tooltip content="Create task" shortcut="T"><Button variant="primary" icon={Plus}>Task</Button></Tooltip>
          <Tooltip content="Below" side="bottom" shortcut={['⌘', '\\']}><Button variant="ghost">Below</Button></Tooltip>
        </Row>
        <Row label="kbd"><Kbd>⌘</Kbd><Kbd>K</Kbd><Kbd>Esc</Kbd><Kbd>?</Kbd></Row>
      </Section>

      <Section title="Menu (↑ ↓ Enter Esc)">
        <Row label="menu">
          <Button ref={menuAnchor} icon={Settings} onClick={() => setMenuOpen(o => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>Open menu</Button>
        </Row>
        <Menu anchorRef={menuAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} label="Task actions" width={220}>
          <MenuLabel>Task</MenuLabel>
          <MenuItem icon={Pencil} shortcut="E" onClick={() => setLast('rename')}>Rename</MenuItem>
          <MenuItem icon={Copy} shortcut="D" onClick={() => setLast('duplicate')}>Duplicate</MenuItem>
          <MenuItem icon={Star} selected onClick={() => setLast('favourite')}>Favourite (selected)</MenuItem>
          <MenuItem icon={Archive} disabled>Archive (disabled)</MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger shortcut="⌫" onClick={() => setLast('delete')}>Delete</MenuItem>
        </Menu>
      </Section>

      <Section title="AvatarStack">
        <Row label="1 / 3 / 6"><AvatarStack names={PEOPLE.slice(0, 1)} /><AvatarStack names={PEOPLE.slice(0, 3)} /><AvatarStack names={PEOPLE} /></Row>
        <Row label="max 2, 18px"><AvatarStack names={PEOPLE} max={2} size={18} /></Row>
        <Row label="max 5, 28px"><AvatarStack names={PEOPLE} max={5} size={28} /></Row>
      </Section>

      <Section title="GhostCell (hover the row)">
        <div className="ui-ghost-host" style={{ display: 'grid', gridTemplateColumns: '1fr repeat(4, 80px)', alignItems: 'center', height: 36, padding: '0 8px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13 }}>Task with empty cells</span>
          <GhostCell icon={User} label="Set owner" onClick={() => setLast('owner')} />
          <GhostCell icon={Calendar} label="Set deadline" onClick={() => setLast('deadline')} />
          <GhostCell icon={Flag} label="Set priority" onClick={() => setLast('priority')} />
          <GhostCell icon={FolderKanban} label="Set program" onClick={() => setLast('program')} />
        </div>
      </Section>

      <Section title="SegmentedTabs (← →)">
        <SegmentedTabs label="Views" value={tab} onChange={setTab} tabs={[
          { value: 'list', label: 'List', icon: List, count: 42 },
          { value: 'board', label: 'Board', icon: Kanban },
          { value: 'calendar', label: 'Calendar', icon: CalendarDays },
          { value: 'gantt', label: 'Gantt (disabled)', disabled: true },
        ]} />
        <div style={{ height: 1, background: 'var(--border)' }} />
      </Section>

      <Section title="EmptyState">
        <EmptyState icon={Inbox} title="No tasks here yet" body="Tasks you own or follow in this space show up here."
          action={<Button variant="primary" icon={Plus}>Task</Button>} />
        <EmptyState icon={Search} title="No matches" body="Try a different search or clear the filters." />
      </Section>

      <Section title="Elevation 1–5 · radii">
        <Row label="elev">
          {[1, 2, 3, 4, 5].map(n => (
            <div key={n} style={{ width: 80, height: 56, background: 'var(--surface)', borderRadius: 'var(--r-card)', boxShadow: `var(--elev-${n})`, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--text-2)' }}>elev-{n}</div>
          ))}
        </Row>
      </Section>
    </div>
  );
}
