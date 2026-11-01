// Objects view: the database-level list of tables and views (like Navicat's
// "Objects" tab), its toolbar, the right-click menus for tables / databases, and
// the table operations they trigger (new, rename, duplicate, empty, drop).

import { esc, escJs, ti, TABLE_ICON, VIEW_ICON } from './util.js';
import { formatBytes } from './export.js';

const OBJ_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'rows', label: 'Rows', num: true, title: 'Row counts are estimates for InnoDB tables' },
  { key: 'auto_increment', label: 'Auto Inc.', num: true },
  { key: 'data_length', label: 'Data Size', num: true },
  { key: 'index_length', label: 'Index Size', num: true },
  { key: 'engine', label: 'Engine' },
  { key: 'collation', label: 'Collation' },
  { key: 'modified', label: 'Modified' },
  { key: 'comment', label: 'Comment' }
];

// Tabler icon for each toolbar command.
const TOOL_ICONS = {
  open: 'table',
  design: 'table-options',
  new: 'table-plus',
  rename: 'cursor-text',
  duplicate: 'copy',
  empty: 'eraser',
  drop: 'table-minus',
  import: 'table-import',
  export: 'table-export',
  refresh: 'refresh'
};

const icon = (cmd) => ti(TOOL_ICONS[cmd]);

/** POST a JSON action. Bulk actions answer 200 with per-table `errors`. */
async function postAction(app, action, body) {
  const res = await fetch(`${app.apiUrl}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 401) {
    app.handleSessionExpired();
    throw new Error('Your session has expired.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function listNames(names, max = 8) {
  const shown = names.slice(0, max).map(n => `• ${n}`).join('\n');
  return names.length > max ? `${shown}\n…and ${names.length - max} more` : shown;
}

// ─── DATA ───────────────────────────────────────────────────

export async function loadObjectsInfo() {
  const db = this.S.db;
  if (!db) return;
  const seq = (this._objSeq = (this._objSeq || 0) + 1);
  this._objLoadingDb = db;
  this.S.objLoading = true;

  try {
    const info = await this.fetchTablesStatus(db);
    if (seq !== this._objSeq) return; // a newer load replaced this one
    this.S.objInfo = (info || []).map(o => ({ ...o, modified: o.update_time || o.create_time || '' }));
    const names = new Set(this.S.objInfo.map(o => o.name));
    for (const n of [...this.S.objSelected]) if (!names.has(n)) this.S.objSelected.delete(n);
  } catch (err) {
    if (seq !== this._objSeq) return;
    this.S.objInfo = [];
    this.showMsg(err.message, 'error');
  } finally {
    if (seq === this._objSeq) {
      this.S.objDb = db;
      this.S.objLoading = false;
      this._objLoadingDb = null;
    }
  }
  if (this.S.tab === 'objects' && this.S.db === db) this.renderObjectsPanel();
}

/** Objects that pass the filter, in the current sort order. */
export function visibleObjects() {
  const filter = (this.S.objFilter || '').toLowerCase().trim();
  const { col, dir } = this.S.objSort || { col: 'name', dir: 'asc' };
  const isNum = OBJ_COLUMNS.find(c => c.key === col)?.num;
  const mult = dir === 'desc' ? -1 : 1;

  return (this.S.objInfo || [])
    .filter(o => !filter || o.name.toLowerCase().includes(filter) || (o.comment || '').toLowerCase().includes(filter))
    .sort((a, b) => {
      const av = a[col], bv = b[col];
      // Empty values (views have no size, tables may have no auto-increment) sort last.
      const aEmpty = av === null || av === undefined || av === '';
      const bEmpty = bv === null || bv === undefined || bv === '';
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      let cmp = isNum ? (Number(av) || 0) - (Number(bv) || 0)
        : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      if (cmp === 0 && col !== 'name') cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      return cmp * mult;
    });
}

/** Selected names in display order. */
export function selectedObjNames() {
  return this.visibleObjects().map(o => o.name).filter(n => this.S.objSelected.has(n));
}

function objType(app, db, name) {
  if (db === app.S.objDb) {
    const o = (app.S.objInfo || []).find(i => i.name === name);
    if (o) return o.type;
  }
  return (app.APP.databases[db]?.views || []).includes(name) ? 'VIEW' : 'TABLE';
}

// ─── RENDER ─────────────────────────────────────────────────

export function renderObjectsPanel() {
  const p = document.getElementById('panel');
  if (!p) return;

  if (!this.S.db) {
    p.innerHTML = '<div class="obj-empty-state">Select a database from the sidebar to see its tables.</div>';
    return;
  }

  if (this.S.objDb !== this.S.db) {
    // Different database: start fresh and fetch its objects.
    this.S.objSelected.clear();
    this.S.objAnchor = null;
    this.S.objFilter = '';
    this.S.objInfo = [];
    if (this._objLoadingDb !== this.S.db) this.loadObjectsInfo();
  }

  const { col: sortCol, dir: sortDir } = this.S.objSort;
  const tool = (cmd, label, need, extra = '') =>
    `<button type="button" class="obj-tool ${extra}" data-cmd="${cmd}" data-need="${need}" onclick="window._dbm.objCmd('${cmd}')">${icon(cmd)}<span>${label}</span></button>`;

  p.innerHTML = `
    <div class="obj-view">
      <div class="obj-toolbar" role="toolbar" aria-label="Table actions">
        ${tool('open', 'Open Table', 'one')}
        ${tool('design', 'Design Table', 'one')}
        ${tool('new', 'New Table', 'none')}
        <span class="obj-tool-sep"></span>
        ${tool('rename', 'Rename', 'one')}
        ${tool('duplicate', 'Duplicate', 'one')}
        ${tool('empty', 'Empty', 'some', 'warn')}
        ${tool('drop', 'Drop', 'some', 'danger')}
        <span class="obj-tool-sep"></span>
        ${tool('import', 'Import', 'none')}
        ${tool('export', 'Export', 'none')}
        ${tool('refresh', 'Refresh', 'none')}
        <div class="obj-search">
          ${ti('search')}
          <input id="obj-filter" type="search" placeholder="Filter tables…" aria-label="Filter tables" value="${esc(this.S.objFilter)}" oninput="window._dbm.onObjFilter(this.value)">
        </div>
      </div>

      <div class="obj-grid-wrap" id="obj-grid" tabindex="0" onkeydown="window._dbm.onObjGridKey(event)" oncontextmenu="window._dbm.onObjBlankContextMenu(event)">
        <table class="dgrid obj-grid">
          <thead>
            <tr>
              <th class="obj-check dg-check"><input type="checkbox" id="obj-check-all" aria-label="Select all tables" onclick="window._dbm.toggleObjSelectAll(this.checked)"></th>
              ${OBJ_COLUMNS.map(c => `
                <th class="${c.num ? 'num' : ''} ${c.key === 'name' ? 'obj-col-name' : ''} ${sortCol === c.key ? 'sorted' : ''}"
                    ${c.title ? `title="${esc(c.title)}"` : ''}
                    aria-sort="${sortCol === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}"
                    onclick="window._dbm.setObjSort('${c.key}')">
                  ${c.label}<span class="obj-sort-arrow">${sortCol === c.key ? (sortDir === 'asc' ? '<i class="ti ti-arrow-up" aria-hidden="true"></i>' : '<i class="ti ti-arrow-down" aria-hidden="true"></i>') : ''}</span>
                </th>`).join('')}
            </tr>
          </thead>
          <tbody id="obj-tbody"></tbody>
        </table>
      </div>

      <div class="obj-footer" id="obj-footer"></div>
    </div>`;

  this.renderObjectRows();
}

export function renderObjectRows() {
  const tbody = document.getElementById('obj-tbody');
  if (!tbody) return;

  const all = this.S.objInfo || [];
  const rows = this.visibleObjects();
  const colspan = OBJ_COLUMNS.length + 1;

  if (this.S.objLoading && all.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="obj-msg-cell"><span class="spinner"></span> Loading tables…</td></tr>`;
  } else if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="obj-msg-cell">${all.length ? 'No tables match the filter.' : 'This database has no tables yet. Click <strong>New Table</strong> to create one.'}</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(o => {
      const isView = o.type === 'VIEW';
      const n = escJs(o.name);
      const num = (v) => (isView || v === null || v === undefined) ? '' : Number(v).toLocaleString();
      const bytes = (v) => isView ? '' : formatBytes(v || 0);
      return `
        <tr class="obj-row ${this.S.objSelected.has(o.name) ? 'selected' : ''} ${this.S.table === o.name ? 'current' : ''}"
            data-name="${esc(o.name)}"
            onclick="window._dbm.onObjRowClick(event, '${n}')"
            ondblclick="window._dbm.openObjectIn(window._dbm.S.db, '${n}', 'browse')"
            oncontextmenu="window._dbm.onObjRowContextMenu(event, '${n}')">
          <td class="obj-check dg-check"><input type="checkbox" tabindex="-1" aria-label="Select ${esc(o.name)}" ${this.S.objSelected.has(o.name) ? 'checked' : ''} onclick="event.stopPropagation(); window._dbm.toggleObjSelected('${n}')"></td>
          <td class="obj-col-name"><span class="obj-name ${isView ? 'is-view' : ''}">${isView ? VIEW_ICON : TABLE_ICON}<span>${esc(o.name)}</span></span></td>
          <td class="num">${num(o.rows)}</td>
          <td class="num">${num(o.auto_increment)}</td>
          <td class="num">${bytes(o.data_length)}</td>
          <td class="num">${bytes(o.index_length)}</td>
          <td>${isView ? '<span class="obj-view-tag">VIEW</span>' : esc(o.engine)}</td>
          <td class="obj-dim">${esc(o.collation)}</td>
          <td class="obj-dim obj-nowrap">${esc(o.modified)}</td>
          ${o.view_error
            ? `<td class="obj-comment obj-view-error" title="${esc(o.view_error)}">${ti('alert-triangle')} Broken view (right-click to fix): ${esc(o.view_error)}</td>`
            : `<td class="obj-comment" title="${esc(o.comment)}">${esc(o.comment)}</td>`}
        </tr>`;
    }).join('');
  }

  this.updateObjSelectionUI();
}

/** Syncs row highlight, checkboxes, toolbar state and the footer with the selection. */
export function updateObjSelectionUI() {
  const sel = this.S.objSelected;
  document.querySelectorAll('#obj-tbody tr.obj-row').forEach(tr => {
    const on = sel.has(tr.dataset.name);
    tr.classList.toggle('selected', on);
    tr.setAttribute('aria-selected', on ? 'true' : 'false');
    const cb = tr.querySelector('input[type=checkbox]');
    if (cb) cb.checked = on;
  });

  const visible = this.visibleObjects();
  const selVisible = visible.filter(o => sel.has(o.name));
  const all = document.getElementById('obj-check-all');
  if (all) {
    all.checked = visible.length > 0 && selVisible.length === visible.length;
    all.indeterminate = selVisible.length > 0 && selVisible.length < visible.length;
  }

  const onlyViews = selVisible.length > 0 && selVisible.every(o => o.type === 'VIEW');
  const singleView = selVisible.length === 1 && selVisible[0].type === 'VIEW';
  document.querySelectorAll('.obj-tool').forEach(btn => {
    const need = btn.dataset.need;
    let disabled = (need === 'one' && selVisible.length !== 1) || (need === 'some' && selVisible.length === 0);
    if ((btn.dataset.cmd === 'design' || btn.dataset.cmd === 'duplicate') && singleView) disabled = true;
    if (btn.dataset.cmd === 'empty' && onlyViews) disabled = true;
    btn.disabled = disabled;
  });

  const footer = document.getElementById('obj-footer');
  if (footer) {
    const info = this.S.objInfo || [];
    const views = info.filter(o => o.type === 'VIEW').length;
    const tables = info.length - views;
    const size = info.reduce((s, o) => s + (o.size || 0), 0);
    const parts = [
      `<strong>${tables}</strong> ${tables === 1 ? 'table' : 'tables'}`,
      views ? `<strong>${views}</strong> ${views === 1 ? 'view' : 'views'}` : '',
      formatBytes(size)
    ].filter(Boolean);
    if (visible.length !== info.length) parts.push(`showing ${visible.length}`);
    footer.innerHTML = `
      <span>${parts.join(' · ')}</span>
      <span>${selVisible.length ? `<strong>${selVisible.length}</strong> selected` : ''}</span>
      <span class="obj-hint">Double-click to open · Right-click for more · Del to drop · F2 to rename</span>`;
  }
}

// ─── INTERACTION ────────────────────────────────────────────

export function setObjSort(col) {
  const cur = this.S.objSort;
  // Numbers and dates are more useful largest / newest first.
  const firstDir = (OBJ_COLUMNS.find(c => c.key === col)?.num || col === 'modified') ? 'desc' : 'asc';
  this.S.objSort = cur.col === col ? { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: firstDir };
  this.saveLocalState();
  this.renderObjectsPanel();
}

export function onObjFilter(val) {
  this.S.objFilter = val || '';
  // Don't keep hidden rows selected: Drop/Empty would act on tables you can't see.
  const visible = new Set(this.visibleObjects().map(o => o.name));
  for (const n of [...this.S.objSelected]) if (!visible.has(n)) this.S.objSelected.delete(n);
  this.renderObjectRows();
}

export function onObjRowClick(e, name) {
  const sel = this.S.objSelected;
  const order = this.visibleObjects().map(o => o.name);
  const anchor = this.S.objAnchor;

  if (e.shiftKey && anchor && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(name)].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) sel.clear();
    order.slice(a, b + 1).forEach(n => sel.add(n));
  } else if (e.ctrlKey || e.metaKey) {
    sel.has(name) ? sel.delete(name) : sel.add(name);
    this.S.objAnchor = name;
  } else {
    sel.clear();
    sel.add(name);
    this.S.objAnchor = name;
  }
  this.updateObjSelectionUI();
  document.getElementById('obj-grid')?.focus({ preventScroll: true });
}

export function toggleObjSelected(name) {
  const sel = this.S.objSelected;
  sel.has(name) ? sel.delete(name) : sel.add(name);
  this.S.objAnchor = name;
  this.updateObjSelectionUI();
}

export function toggleObjSelectAll(checked) {
  this.S.objSelected.clear();
  if (checked) this.visibleObjects().forEach(o => this.S.objSelected.add(o.name));
  this.updateObjSelectionUI();
}

export function onObjGridKey(e) {
  if (e.target.matches?.('input[type=text], input[type=search]')) return;
  const names = this.selectedObjNames();
  const order = this.visibleObjects().map(o => o.name);

  if (e.key === 'Enter' && names.length === 1) {
    e.preventDefault();
    this.openObjectIn(this.S.db, names[0], 'browse');
  } else if (e.key === 'Delete' && names.length) {
    e.preventDefault();
    this.objDrop(this.S.db, names);
  } else if (e.key === 'F2' && names.length === 1) {
    e.preventDefault();
    this.objRename(this.S.db, names[0]);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    this.toggleObjSelectAll(true);
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && order.length) {
    e.preventDefault();
    const from = order.indexOf(this.S.objAnchor);
    const next = from === -1 ? 0 : Math.min(order.length - 1, Math.max(0, from + (e.key === 'ArrowDown' ? 1 : -1)));
    this.S.objSelected.clear();
    this.S.objSelected.add(order[next]);
    this.S.objAnchor = order[next];
    this.updateObjSelectionUI();
    document.querySelector(`#obj-tbody tr[data-name="${CSS.escape(order[next])}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

/** Toolbar dispatcher: acts on the current selection in the current database. */
export function objCmd(cmd) {
  const db = this.S.db;
  const names = this.selectedObjNames();
  switch (cmd) {
    case 'open': if (names.length === 1) this.openObjectIn(db, names[0], 'browse'); break;
    case 'design': if (names.length === 1) this.openObjectIn(db, names[0], 'structure'); break;
    case 'new': this.objNewTable(db); break;
    case 'rename': if (names.length === 1) this.objRename(db, names[0]); break;
    case 'duplicate': if (names.length === 1) this.objDuplicate(db, names[0]); break;
    case 'empty': if (names.length) this.objEmpty(db, names); break;
    case 'drop': if (names.length) this.objDrop(db, names); break;
    case 'import': this.objImport(db, names); break;
    case 'export': this.objExport(db, names); break;
    case 'refresh': this.refreshDbObjects(db).then(() => this.showMsg(`Refreshed tables in ${db}`)); break;
  }
}

// ─── NAVIGATION ─────────────────────────────────────────────

/** Opens a table in the Browse or Structure tab. */
export function openObjectIn(db, name, tab) {
  this.S.tab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
  this.selectTable(db, name);
}

/** Make `db` the current database without changing the tab. */
export function switchDb(db) {
  if (this.S.db === db) return;
  this.S.db = db;
  this.S.table = '';
  this.S.page = 1;
  this.S.selected.clear();
  this.S.filters = [];
  this.S.appliedFilters = [];
  this.S.sorts = [];
  this.S.appliedSorts = [];
  this.S.expandedDbs.add(db);
  this.renderSidebar();
  this.updateStatus();
}

export function objImport(db, names = []) {
  this.switchDb(db);
  this.S.importTargetTable = names.length === 1 ? names[0] : '';
  this.showTab('import');
}

export function objExport(db, names = []) {
  this.switchDb(db);
  this.S.exportScope = 'database';
  // Hand the export picker this database's list (or an empty one it will fetch),
  // marked as current so showTab() keeps the selection made here.
  this.S.exportTablesInfo = (this.S.objDb === db) ? this.S.objInfo.slice() : [];
  this.S.exportInfoDb = db;
  const all = this.S.objDb === db ? this.S.objInfo.map(o => o.name) : (this.APP.databases[db]?.tables || []);
  this.S.exportTables = new Set(names.length ? names : all);
  this.showTab('export');
}

// ─── OPERATIONS ─────────────────────────────────────────────

/**
 * Re-read a database's table list after a schema change and refresh every
 * place that shows it: sidebar, Objects grid, cached table data, export picker.
 */
export async function refreshDbObjects(db, { renamed = null, removed = [], changed = [] } = {}) {
  try {
    const res = await fetch(`${this.apiUrl}?action=tables&db=${encodeURIComponent(db)}`);
    if (res.status === 401) return this.handleSessionExpired();
    const data = await res.json();
    if (res.ok && data.tables) this.APP.databases[db] = { tables: data.tables, views: data.views || [] };
  } catch (e) { /* the sidebar keeps its old list */ }

  // Cached rows/schemas are keyed by table name; drop anything now out of date.
  const stale = [...removed, ...changed, ...(renamed ? [renamed.from] : [])];
  stale.forEach(t => { delete this.APP.tableData[t]; delete this.APP.schemas[t]; delete this.APP.colHeaders[t]; });

  if (db === this.S.db) {
    if (renamed) {
      if (this.S.table === renamed.from) this.S.table = renamed.to;
      if (this.S.objSelected.delete(renamed.from)) this.S.objSelected.add(renamed.to);
      if (this.S.objAnchor === renamed.from) this.S.objAnchor = renamed.to;
    }
    if (removed.includes(this.S.table)) this.S.table = '';
    removed.forEach(t => this.S.objSelected.delete(t));
    this.S.exportInfoDb = ''; // export picker re-reads sizes and names
    this.saveLocalState();
  }

  this.renderSidebar();
  this.updateStatus();
  if (db === this.S.db && this.S.tab === 'objects') await this.loadObjectsInfo();
}

function reportBulk(app, verb, result) {
  const done = result.done || [];
  const errors = result.errors || [];
  if (done.length) app.showMsg(`${verb} ${done.length} ${done.length === 1 ? 'table' : 'tables'}: ${done.join(', ')}`);
  if (errors.length) {
    errors.forEach(e => app.showMsg(`${e.table}: ${e.error}`, 'error'));
    app.showAlertDialog(
      `${errors.length} ${errors.length === 1 ? 'table' : 'tables'} could not be ${verb.toLowerCase()}`,
      errors.map(e => `${e.table}\n  ${e.error}`).join('\n\n'),
      'error'
    );
  }
}

export function objNewTable(db) {
  this.showPromptDialog('New Table', {
    message: `Create a table in ${db}. It starts with an auto-increment "id" primary key; you add the other columns in the Structure tab.`,
    label: 'Table name',
    placeholder: 'e.g. customers',
    confirmText: 'Create Table'
  }, async (name) => {
    try {
      await postAction(this, 'create_table', { db, name });
      this.showMsg(`Created table ${name} in ${db}`);
      await this.refreshDbObjects(db);
      this.openObjectIn(db, name, 'structure');
    } catch (err) {
      this.showAlertDialog('Could not create table', err.message, 'error');
    }
  });
}

export function objRename(db, oldName) {
  const kind = objType(this, db, oldName) === 'VIEW' ? 'view' : 'table';
  this.showPromptDialog(`Rename ${kind}`, {
    label: 'New name',
    value: oldName,
    confirmText: 'Rename'
  }, async (newName) => {
    if (newName === oldName) return;
    try {
      await postAction(this, 'rename_table', { db, old_name: oldName, new_name: newName });
      this.showMsg(`Renamed ${oldName} to ${newName}`);
      await this.refreshDbObjects(db, { renamed: { from: oldName, to: newName } });
    } catch (err) {
      this.showAlertDialog(`Could not rename ${kind}`, err.message, 'error');
    }
  });
}

export function objDuplicate(db, source) {
  const existing = new Set(this.APP.databases[db]?.tables || []);
  let suggestion = `${source}_copy`;
  for (let i = 2; existing.has(suggestion); i++) suggestion = `${source}_copy${i}`;

  this.showPromptDialog('Duplicate table', {
    message: `Copies the columns and indexes of ${source}. Foreign keys and triggers are not copied.`,
    label: 'New table name',
    value: suggestion,
    checkbox: { label: 'Copy the data too', checked: true },
    confirmText: 'Duplicate'
  }, async (newName, withData) => {
    try {
      const r = await postAction(this, 'duplicate_table', { db, source, new_name: newName, with_data: withData });
      this.showMsg(`Duplicated ${source} as ${newName}${withData ? ` (${(r.rows_copied || 0).toLocaleString()} rows)` : ' (structure only)'}`);
      await this.refreshDbObjects(db);
    } catch (err) {
      this.showAlertDialog('Could not duplicate table', err.message, 'error');
    }
  });
}

export async function objEmpty(db, names) {
  const tables = names.filter(n => objType(this, db, n) !== 'VIEW');
  if (!tables.length) return;
  const ok = await this.confirmDialog({
    type: 'danger',
    title: tables.length === 1 ? `Empty table "${tables[0]}"?` : `Empty ${tables.length} tables?`,
    message: 'Every row is permanently deleted and AUTO_INCREMENT restarts at 1. ' +
      'Foreign key checks are skipped, so rows in other tables that point at these rows are left as they are.',
    details: tables.length > 1 ? listNames(tables) : '',
    confirmText: tables.length === 1 ? 'Empty Table' : `Empty ${tables.length} Tables`
  });
  if (!ok) return;
  try {
    const r = await postAction(this, 'truncate_tables', { db, tables });
    reportBulk(this, 'Emptied', r);
    await this.refreshDbObjects(db, { changed: r.done || [] });
  } catch (err) {
    this.showAlertDialog('Could not empty tables', err.message, 'error');
  }
}

export async function objDrop(db, names) {
  const views = names.filter(n => objType(this, db, n) === 'VIEW').length;
  const what = names.length === 1
    ? `${views ? 'view' : 'table'} "${names[0]}"`
    : `${names.length} ${views === names.length ? 'views' : 'tables'}`;
  const ok = await this.confirmDialog({
    type: 'danger',
    title: `Drop ${what}?`,
    message: 'This permanently deletes the structure and all data, and cannot be undone.',
    details: names.length > 1 ? listNames(names) : '',
    confirmText: names.length === 1 ? 'Drop' : `Drop ${names.length}`
  });
  if (!ok) return;
  try {
    const r = await postAction(this, 'drop_tables', { db, tables: names });
    reportBulk(this, 'Dropped', r);
    await this.refreshDbObjects(db, { removed: r.done || [] });
  } catch (err) {
    this.showAlertDialog('Could not drop', err.message, 'error');
  }
}

/**
 * Repair a view whose creator (DEFINER) doesn't exist on this server: recreate
 * it with the same query, owned by the logged-in user. Asks first.
 */
export function fixViewDefiner(db, view) {
  this.showConfirmDialog(
    `Fix view "${view}"?`,
    `The view is recreated with exactly the same query, but owned by the MySQL user you're logged in as (${this.S.user}) ` +
    `instead of the user that no longer exists. Queries on the view then run with that user's permissions.\n\n` +
    `Nothing else in ${db} changes.`,
    async () => {
      try {
        const r = await postAction(this, 'fix_view_definer', { db, view });
        this.showMsg(`Fixed view ${view}: it now runs as ${r.definer}`);
        if (this.S.db === db && this.S.objDb === db) this.loadObjectsInfo();
        if (this.S.db === db && this.S.table === view) this.loadTableDataFromServer(db, view);
      } catch (err) {
        this.showAlertDialog(`Could not fix view ${view}`, err.message, 'error');
      }
    },
    { confirmText: 'Fix View', type: 'primary' }
  );
}

// ─── CONTEXT MENUS ──────────────────────────────────────────

function tableMenuItems(app, db, names) {
  const one = names.length === 1;
  const name = names[0];
  const isView = one && objType(app, db, name) === 'VIEW';
  const allViews = names.every(n => objType(app, db, n) === 'VIEW');
  const items = [];
  if (one) {
    items.push(
      { label: isView ? 'Open View' : 'Open Table', action: () => app.openObjectIn(db, name, 'browse') },
      { label: 'Design Table', disabled: isView, action: () => app.openObjectIn(db, name, 'structure') },
      { label: 'Open in New Tab', action: () => app.openInNewTab(db, name, 'browse') },
      '-'
    );
  }
  items.push({ label: 'New Table…', action: () => app.objNewTable(db) });
  const broken = isView && db === app.S.objDb && (app.S.objInfo || []).find(o => o.name === name)?.view_error;
  if (broken) items.push({ label: 'Fix Missing Owner…', action: () => app.fixViewDefiner(db, name) });
  if (one) {
    items.push(
      { label: 'Rename…', hint: 'F2', action: () => app.objRename(db, name) },
      { label: 'Duplicate…', disabled: isView, action: () => app.objDuplicate(db, name) }
    );
  }
  items.push(
    '-',
    { label: one ? 'Empty Table…' : `Empty ${names.length} Tables…`, disabled: allViews, danger: true, action: () => app.objEmpty(db, names) },
    { label: one ? (isView ? 'Drop View…' : 'Drop Table…') : `Drop ${names.length} Tables…`, hint: 'Del', danger: true, action: () => app.objDrop(db, names) },
    '-',
    { label: one ? 'Export…' : `Export ${names.length} Tables…`, action: () => app.objExport(db, names) },
    { label: 'Import into Table…', disabled: !one || isView, action: () => app.objImport(db, names) },
    '-',
    ...(one ? [{ label: app.isPinned(db, name) ? 'Unpin from Sidebar' : 'Pin to Sidebar', action: () => app.togglePin(db, name) }] : []),
    { label: one ? 'Copy Name' : 'Copy Names', action: () => app.copyText(names.join('\n'), one ? 'Name copied' : `${names.length} names copied`) }
  );
  return items;
}

export function onObjRowContextMenu(e, name) {
  e.preventDefault();
  e.stopPropagation();
  if (!this.S.objSelected.has(name)) {
    this.S.objSelected.clear();
    this.S.objSelected.add(name);
    this.S.objAnchor = name;
    this.updateObjSelectionUI();
  }
  this.showContextMenu(e.clientX, e.clientY, tableMenuItems(this, this.S.db, this.selectedObjNames()));
}

export function onObjBlankContextMenu(e) {
  if (e.target.closest('tr.obj-row')) return;
  e.preventDefault();
  const db = this.S.db;
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'New Table…', action: () => this.objNewTable(db) },
    { label: 'Import…', action: () => this.objImport(db) },
    { label: 'Export Database…', action: () => this.objExport(db) },
    '-',
    { label: 'Refresh', action: () => this.objCmd('refresh') }
  ]);
}

export function onTableContextMenu(e, db, name) {
  e.preventDefault();
  e.stopPropagation();
  this.showContextMenu(e.clientX, e.clientY, tableMenuItems(this, db, [name]));
}

export function onDbContextMenu(e, db) {
  e.preventDefault();
  e.stopPropagation();
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'Open Objects', action: () => this.handleDbRowClick(db) },
    { label: 'New Table…', action: () => this.objNewTable(db) },
    '-',
    { label: 'Import…', action: () => this.objImport(db) },
    { label: 'Export Database…', action: () => this.objExport(db) },
    '-',
    { label: 'New Query', action: () => { this.switchDb(db); this.S.sqlView = false; this.showTab('sql'); } },
    { label: 'Refresh', action: () => this.refreshDbObjects(db).then(() => this.showMsg(`Refreshed tables in ${db}`)) },
    '-',
    { label: this.isPinned(db) ? 'Unpin from Sidebar' : 'Pin to Sidebar', action: () => this.togglePin(db) },
    { label: 'Copy Name', action: () => this.copyText(db, 'Name copied') }
  ]);
}

export async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    this.showMsg(okMsg);
  } catch (e) {
    this.showMsg('Could not copy to the clipboard', 'error');
  }
}

/**
 * Shows a right-click menu at (x, y). Items are objects
 * { label, action, hint?, danger?, disabled? } or '-' for a separator.
 */
export function showContextMenu(x, y, items) {
  this.closeContextMenu();

  const menu = document.createElement('div');
  menu.id = 'dbm-context-menu';
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');

  items.forEach(it => {
    if (it === '-') {
      if (menu.lastChild && !menu.lastChild.classList.contains('ctx-sep')) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
      }
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!it.disabled;
    btn.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ''}`;
    btn.onclick = () => {
      this.closeContextMenu();
      it.action();
    };
    menu.appendChild(btn);
  });
  if (menu.lastChild?.classList.contains('ctx-sep')) menu.lastChild.remove();

  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;

  const buttons = () => [...menu.querySelectorAll('.ctx-item:not(:disabled)')];
  const onDown = (ev) => { if (!menu.contains(ev.target)) this.closeContextMenu(); };
  const onKey = (ev) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); this.closeContextMenu(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  };
  const onClose = () => this.closeContextMenu();

  // Registered on the next tick so the opening right-click doesn't close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    document.addEventListener('scroll', onClose, true);
  });
  this._ctxCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onClose);
    window.removeEventListener('blur', onClose);
    document.removeEventListener('scroll', onClose, true);
  };
  buttons()[0]?.focus({ preventScroll: true });
}

export function closeContextMenu() {
  if (this._ctxCleanup) this._ctxCleanup();
  this._ctxCleanup = null;
  document.getElementById('dbm-context-menu')?.remove();
}

