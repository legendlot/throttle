'use client';
// /tasks page chrome (ClickUp redesign P2): the views bar (List · Board · + View,
// Copy link, space actions) and the 40px toolbar (Group pill · Subtasks | Filter ·
// Me · Archive done · Select · search · Customize · + Task). State lives in
// tasks/page.js; these only render it. Rows / groups / cards are P3–P4.
import { useRef } from 'react';
import {
  Layers, X, ChevronDown, ListFilter, UserCheck, Archive, CheckSquare, Check, Search, Settings2, Plus,
  List, Columns3, Link2, LayoutDashboard, ListTree, ChevronsDownUp, ChevronsUpDown, FolderPlus, CornerDownRight, SquarePen,
} from 'lucide-react';
import { STATUSES, PRIORITIES } from '../../lib/tasks.js';
import { Button, IconButton, SplitButton, SegmentedTabs, Tooltip, Popover, Menu, MenuItem, MenuLabel, MenuSeparator, Kbd } from '../ui/index.js';

/* ---------------- Views bar ---------------- */
export function ViewsBar({ viewMode, onView, allowBoard, onCopyLink, space, onSpaceDashboard, onSpaceSettings }) {
  const tabs = [{ value: 'list', label: 'List', icon: List }];
  if (allowBoard) tabs.push({ value: 'board', label: 'Board', icon: Columns3 });
  return (
    <div className="tk-views">
      <SegmentedTabs label="View" tabs={tabs} value={allowBoard ? viewMode : 'list'} onChange={onView} />
      <Tooltip content="Saved views — coming soon">
        <Button variant="ghost" size="sm" icon={Plus} aria-disabled="true" className="tk-views-add" onClick={(e) => e.preventDefault()}>View</Button>
      </Tooltip>
      <span className="tk-spacer" />
      <IconButton icon={Link2} size="sm" label="Copy link" onClick={onCopyLink} />
      {space?.is_private && <IconButton icon={LayoutDashboard} size="sm" label="Space dashboard" onClick={onSpaceDashboard} />}
      {space?.is_private && space.is_owner && <IconButton icon={Settings2} size="sm" label="Space settings" onClick={onSpaceSettings} />}
    </div>
  );
}

/* ---------------- Toolbar ---------------- */
const GROUP_LABEL = { none: 'None', person: 'Owner', department: 'Team', status: 'Status', program: 'Program' };

function ToggleBtn({ on, icon, children, tip, onClick }) {
  const b = (
    <Button variant="ghost" size="md" icon={icon} className={on ? 'is-active' : undefined} aria-pressed={on} onClick={onClick}>{children}</Button>
  );
  return tip ? <Tooltip content={tip}>{b}</Tooltip> : b;
}

export function TasksToolbar(p) {
  const groupRef = useRef(null);
  const subRef = useRef(null);
  const filterRef = useRef(null);
  const custRef = useRef(null);
  const newRef = useRef(null);
  const subTarget = p.newTaskMenuOpen ? p.getSubtaskTarget?.() : null;
  return (
    <div className="tk-toolbar">
      <div className="tk-tb-left">
        {p.showGroup && (
          <span className={'tk-pill' + (p.groupBy !== 'none' ? ' on' : '')}>
            <button ref={groupRef} type="button" className="tk-pill-main" aria-haspopup="menu" onClick={() => p.setGroupMenu(m => !m)}>
              <Layers size={13} strokeWidth={2} aria-hidden />
              <span>Group: {GROUP_LABEL[p.groupBy] || 'None'}</span>
            </button>
            {p.groupBy !== 'none' && (
              <button type="button" className="tk-pill-x" aria-label="Clear grouping" onClick={() => p.setGroupBy('none')}><X size={12} strokeWidth={2} /></button>
            )}
          </span>
        )}
        <Menu anchorRef={groupRef} open={p.showGroup && p.groupMenu} onClose={() => p.setGroupMenu(false)} width={180} label="Group by">
          <MenuLabel>Group by</MenuLabel>
          {p.groupOpts.map(o => (
            <MenuItem key={o.value} selected={p.groupBy === o.value}
              icon={<Check size={14} style={{ opacity: p.groupBy === o.value ? 1 : 0 }} aria-hidden />}
              onClick={() => p.setGroupBy(o.value)}>{o.label}</MenuItem>
          ))}
        </Menu>

        {p.showSubtasks && <>
          <Button ref={subRef} variant="ghost" size="md" icon={ListTree} iconRight={ChevronDown} aria-haspopup="menu"
            onClick={() => p.setSubMenu(o => !o)}>Subtasks</Button>
          <Menu anchorRef={subRef} open={p.subMenu} onClose={() => p.setSubMenu(false)} width={180} label="Subtasks">
            <MenuItem icon={ChevronsUpDown} onClick={p.onExpandAll}>Expand all</MenuItem>
            <MenuItem icon={ChevronsDownUp} onClick={p.onCollapseAll}>Collapse all</MenuItem>
          </Menu>
        </>}
      </div>

      <div className="tk-tb-right">
        <Button ref={filterRef} variant="ghost" size="md" icon={ListFilter} className={p.filterCount > 0 ? 'is-active' : undefined}
          aria-haspopup="dialog" aria-expanded={p.filterOpen} onClick={() => p.setFilterOpen(o => !o)}>
          Filter{p.filterCount > 0 && <span className="tk-badge">{p.filterCount}</span>}
        </Button>
        <Popover anchorRef={filterRef} open={p.filterOpen} onClose={() => p.setFilterOpen(false)} align="right" width={280} className="tk-fp" role="dialog" aria-label="Filters">
          <FilterPanel {...p.filter} />
        </Popover>

        {p.showMe && <ToggleBtn on={p.mine} icon={UserCheck} tip="Tasks I own, am assigned, collaborate on, or raised" onClick={() => p.setMine(m => !m)}>Me</ToggleBtn>}
        {p.showArchive && (
          <ToggleBtn on={p.archiveDone} icon={Archive} onClick={p.toggleArchiveDone}
            tip={p.archiveDone ? 'Done tasks are archived — click to show them on the board' : 'Archive done tasks into a collapsed section'}>
            {p.archiveDone ? 'Done archived' : 'Archive done'}
          </ToggleBtn>
        )}
        {p.showSelect && (
          <ToggleBtn on={p.selectMode} icon={CheckSquare} tip="Select multiple tasks to update them in bulk" onClick={p.toggleSelectMode}>Select</ToggleBtn>
        )}
        {p.showSelect && p.selectMode && p.selectableCount > 0 && (
          <Button variant="ghost" size="md" onClick={p.toggleSelectAll}>
            {p.allSelected ? 'Clear all' : 'Select all'}{p.selectedCount > 0 && <span className="tk-badge">{p.selectedCount}</span>}
          </Button>
        )}

        <label className="tk-search">
          <Search size={13} strokeWidth={2} aria-hidden />
          <input data-search-primary ref={p.searchRef} value={p.q} onChange={e => p.setQ(e.target.value)}
            placeholder="Search…" aria-label="Search tasks, owners, DKT-no" />
          {p.q
            ? <button type="button" className="tk-search-x" aria-label="Clear search" onClick={() => p.setQ('')}><X size={12} /></button>
            : <Kbd>/</Kbd>}
        </label>

        {p.showCustomize && <>
          <IconButton ref={custRef} icon={Settings2} label="Customize" aria-haspopup="menu" onClick={() => p.setCustOpen(o => !o)} />
          <Menu anchorRef={custRef} open={p.custOpen} onClose={() => p.setCustOpen(false)} align="right" width={180} label="Customize">
            <MenuLabel>Density</MenuLabel>
            {[['compact', 'Compact'], ['default', 'Default'], ['roomy', 'Roomy']].map(([v, l]) => (
              <MenuItem key={v} keepOpen selected={p.density === v}
                icon={<Check size={14} style={{ opacity: p.density === v ? 1 : 0 }} aria-hidden />}
                onClick={() => p.chooseDensity(v)}>{l}</MenuItem>
            ))}
          </Menu>
        </>}

        <SplitButton variant="primary" size="md" icon={Plus} onMain={p.onNewTask}
          onMenu={() => p.setNewTaskMenuOpen(o => !o)} menuRef={newRef} menuLabel="More create options">Task</SplitButton>
        <Menu anchorRef={newRef} open={p.newTaskMenuOpen} onClose={() => p.setNewTaskMenuOpen(false)} align="right" width={240} label="Create">
          <MenuItem icon={SquarePen} shortcut="c" onClick={p.onNewTask}>New task</MenuItem>
          <MenuItem icon={CornerDownRight} disabled={!subTarget} onClick={() => subTarget && p.onNewSubtask(subTarget.id)}>
            {subTarget ? `New sub-task · ${subTarget.task_no || 'focused task'}` : 'New sub-task (focus a task first)'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={FolderPlus} onClick={p.onNewSpace}>New space</MenuItem>
        </Menu>
      </div>
    </div>
  );
}

/* ---------------- Filter panel (inside the Filter popover) ---------------- */
function FilterPanel({ status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId,
  priority, setPriority, programId, setProgramId, overdue, setOverdue, revised, setRevised,
  teamOpts, empOpts, programOpts, filterCount, clearFilters, hideProgramFilter, hideOwnerFilter }) {
  const Sel = ({ label, value, set, any, options }) => (
    <label className="tk-fp-grp">
      <span className="tk-fp-lbl">{label}</span>
      <select className="tk-fp-sel" value={value || ''} onChange={e => set(e.target.value || '')}>
        <option value="">{any}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  return (
    <div className="tk-fp-body">
      <Sel label="Status" value={status} set={setStatus} any="Any status" options={STATUSES.map(s => ({ value: s.key, label: s.label }))} />
      <Sel label="Team" value={departmentId} set={setDepartmentId} any="Any team" options={teamOpts} />
      {!hideOwnerFilter && <Sel label="Owner" value={employeeId} set={setEmployeeId} any="Anyone" options={empOpts} />}
      <Sel label="Priority" value={priority} set={setPriority} any="Any priority" options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))} />
      {!hideProgramFilter && <Sel label="Program" value={programId} set={setProgramId} any="Any program" options={programOpts} />}
      <div className="tk-fp-grp">
        <span className="tk-fp-lbl">Quick</span>
        <div className="tk-fp-toggles">
          <Button variant="neutral" size="sm" className={overdue ? 'is-on' : undefined} aria-pressed={overdue} onClick={() => setOverdue(o => !o)}>Overdue</Button>
          <Button variant="neutral" size="sm" className={revised ? 'is-on' : undefined} aria-pressed={revised} onClick={() => setRevised(r => !r)}>Revised</Button>
        </div>
      </div>
      {filterCount > 0 && <Button variant="ghost" size="sm" className="tk-fp-clear" onClick={clearFilters}>Clear filters</Button>}
    </div>
  );
}
