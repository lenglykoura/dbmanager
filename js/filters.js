// The Browse tab's filter bar: conditions written as "column · condition · value"
// where the value box matches the column (date picker, ENUM/boolean dropdown,
// relationship picker, two boxes for "between"), "and / or" matching, sort rules,
// chips that summarise what's active when the bar is closed, and right-click
// shortcuts on cells and column headers. Changes apply automatically.
//
// Conditions live in S.filters next to the filter row's quick filters (ids that
// start with "qcol_"); the server ANDs the quick filters and combines these with
// S.filterMatch ("all" = AND, "any" = OR).

import { esc, escJs, ti } from './util.js';
import { columnInputSpec } from './cellinput.js';

let seq = 1;
const newId = () => `f${seq++}`; // never "qcol_…", which marks filter-row entries

// [operator sent to the server, label, number of values it takes]
const OPS = {
  text: [['contains', 'contains', 1], ['not contains', "doesn't contain", 1], ['=', 'is', 1], ['!=', 'is not', 1],
    ['starts with', 'starts with', 1], ['ends with', 'ends with', 1], ['is empty', 'is empty', 0],
    ['is not empty', 'is not empty', 0], ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]],
  number: [['=', '=', 1], ['!=', '≠', 1], ['>', '>', 1], ['>=', '≥', 1], ['<', '<', 1], ['<=', '≤', 1],
    ['between', 'between', 2], ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]],
  date: [['=', 'is on', 1], ['!=', 'is not on', 1], ['>', 'is after', 1], ['>=', 'is on or after', 1],
    ['<', 'is before', 1], ['<=', 'is on or before', 1], ['between', 'is between', 2],
    ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]],
  time: [['=', 'is', 1], ['>', 'is after', 1], ['<', 'is before', 1], ['between', 'is between', 2],
    ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]],
  enum: [['=', 'is', 1], ['!=', 'is not', 1], ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]],
  bool: [['=', 'is', 1], ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]],
  fk: [['=', 'is', 1], ['!=', 'is not', 1], ['fk', 'name contains', 1], ['is null', 'is NULL', 0], ['is not null', 'is not NULL', 0]]
};
const opsFor = (kind) => OPS[kind === 'datetime' ? 'date' : kind] || OPS.text;
const opInfo = (kind, op) => opsFor(kind).find(o => o[0] === op) || [op, op, 1];
const isQuick = (f) => String(f.id).startsWith('qcol_');

const SORT_LABELS = {
  number: ['1 → 9', '9 → 1'], date: ['oldest first', 'newest first'], datetime: ['oldest first', 'newest first'],
  time: ['earliest first', 'latest first'], text: ['A → Z', 'Z → A']
};
const sortLabels = (kind) => SORT_LABELS[kind] || SORT_LABELS.text;

function colDef(app, col) {
  return (app.APP.schemas[app.S.table] || []).find(c => c.n === col);
}

/** What kind of value a column holds, which decides its conditions and value box. */
function kindOf(app, col) {
  if (app.fkMetaFor(col)) return 'fk';
  const def = colDef(app, col);
  const t = String(def?.t || '').toLowerCase();
  if (/^enum\(/.test(t)) return 'enum';
  if (/^(tinyint\(1\)|bool|boolean)\b/.test(t)) return 'bool';
  const spec = columnInputSpec(def);
  if (spec) return ['date', 'datetime', 'time'].includes(spec.kind) ? spec.kind : 'number';
  return 'text';
}

function enumValues(app, col) {
  const m = String(colDef(app, col)?.t || '').match(/^enum\((.*)\)$/i);
  const out = [];
  if (m) {
    const re = /'((?:''|[^'])*)'/g;
    let x;
    while ((x = re.exec(m[1])) !== null) out.push(x[1].replace(/''/g, "'"));
  }
  return out;
}

function isComplete(app, f) {
  if (!f.col || !f.op) return false;
  const arity = opInfo(kindOf(app, f.col), f.op)[2];
  if (arity === 0) return true;
  if (String(f.val ?? '') === '') return false;
  return arity === 1 || String(f.val2 ?? '') !== '';
}

function newCondition(app, col) {
  const kind = kindOf(app, col);
  return {
    id: newId(), active: true, col, op: kind === 'text' ? 'contains' : opsFor(kind)[0][0],
    val: '', val2: '', label: '', fn: kind === 'datetime' ? 'date' : undefined
  };
}

const advanced = (app) => (app.S.filters || []).filter(f => !isQuick(f));

// ─── APPLYING ───────────────────────────────────────────────

/**
 * Send the filter bar's complete conditions (plus the filter row's) and sort
 * rules to the server. Typing waits 350 ms; other changes apply at once.
 * Nothing is fetched if the effective query didn't change (e.g. a condition
 * that isn't filled in yet).
 */
export function applyFilterBar(immediate = false) {
  clearTimeout(this._fbTimer);
  const run = () => {
    const next = this.completeFilters();
    const match = this.S.filterMatch || 'all';
    const sorts = (this.S.sorts || []).filter(s => s.col);
    const same = JSON.stringify([next, sorts, match]) ===
      JSON.stringify([this.S.appliedFilters || [], this.S.appliedSorts || [], this.S.appliedMatch || 'all']);
    if (same) return;
    this.S.appliedFilters = JSON.parse(JSON.stringify(next));
    this.S.appliedSorts = JSON.parse(JSON.stringify(sorts));
    this.S.appliedMatch = match;
    this.S.page = 1;
    this.loadTableDataFromServer(this.S.db, this.S.table, { quiet: true });
  };
  if (immediate) run();
  else this._fbTimer = setTimeout(run, 350);
}

/** Re-render the panel and put the cursor back into the given filter-bar field. */
function rerender(app, focusKey) {
  if (focusKey) app._fbFocus = { key: focusKey };
  app.renderPanel();
}

/** Called by renderPanel after the grid is redrawn: restore focus in the filter bar. */
export function restoreFilterFocus(saved) {
  const want = this._fbFocus || saved;
  this._fbFocus = null;
  if (!want) return;
  const el = document.querySelector(`[data-fkey="${CSS.escape(want.key)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (want.start != null) {
    try { el.setSelectionRange(want.start, want.end ?? want.start); } catch (e) { /* not a text field */ }
  }
}

// ─── EDITING CONDITIONS ─────────────────────────────────────

export function fbAdd(col = null, focusValue = false) {
  const headers = this.APP.colHeaders[this.S.table] || [];
  const f = newCondition(this, col || headers[0] || '');
  this.S.filters = [...(this.S.filters || []), f];
  this.S.showBuilder = true;
  rerender(this, `${f.id}:${focusValue ? 'val' : 'col'}`);
}

export function fbRemove(id) {
  this.S.filters = (this.S.filters || []).filter(f => f.id !== id);
  rerender(this);
  this.applyFilterBar(true);
}

export function fbToggle(id) {
  const f = (this.S.filters || []).find(x => x.id === id);
  if (!f) return;
  f.active = !f.active;
  rerender(this);
  this.applyFilterBar(true);
}

export function fbSetCol(id, col) {
  const f = (this.S.filters || []).find(x => x.id === id);
  if (!f) return;
  Object.assign(f, newCondition(this, col), { id: f.id, active: f.active });
  const arity = opInfo(kindOf(this, col), f.op)[2];
  rerender(this, `${id}:${arity ? 'val' : 'op'}`);
  this.applyFilterBar(true);
}

export function fbSetOp(id, op) {
  const f = (this.S.filters || []).find(x => x.id === id);
  if (!f) return;
  const kind = kindOf(this, f.col);
  // Switching between "is <row>" and "name contains <text>" changes what the value means.
  if (kind === 'fk' && (op === 'fk') !== (f.op === 'fk')) { f.val = ''; f.label = ''; }
  f.op = op;
  if (opInfo(kind, op)[2] < 2) f.val2 = '';
  if (opInfo(kind, op)[2] === 0) f.val = '';
  rerender(this, `${id}:${opInfo(kind, op)[2] ? 'val' : 'op'}`);
  this.applyFilterBar(true);
}

/** Value typed or chosen. Typing (immediate=false) waits for a pause before applying. */
export function fbSetVal(id, field, value, immediate = false) {
  const f = (this.S.filters || []).find(x => x.id === id);
  if (!f) return;
  f[field] = value;
  if (field === 'val') f.label = '';
  document.querySelector(`[data-fkey="${CSS.escape(`${id}:${field}`)}"]`)?.closest('.fbar-row')
    ?.classList.toggle('incomplete', !isComplete(this, f));
  this.applyFilterBar(immediate);
}

/** "is <row>" on a relationship column: choose the row with the searchable picker. */
export function fbPickFk(btn, id) {
  const f = (this.S.filters || []).find(x => x.id === id);
  if (!f) return;
  this.openFkPicker(btn, {
    table: this.S.table,
    column: f.col,
    current: f.val === '' ? undefined : f.val,
    nullable: false,
    freeText: (q) => `Use “${q}” as the ID`
  }, (pick) => {
    f.val = String(pick.val);
    f.label = pick.free ? '' : (pick.label ?? '');
    rerender(this, `${id}:val`);
    this.applyFilterBar(true);
  });
}

export function fbToggleMatch() {
  this.S.filterMatch = (this.S.filterMatch || 'all') === 'all' ? 'any' : 'all';
  rerender(this);
  this.applyFilterBar(true);
}

export function fbClearAll() {
  this.S.filters = (this.S.filters || []).filter(isQuick);
  this.S.sorts = [];
  this.S.filterMatch = 'all';
  rerender(this);
  this.applyFilterBar(true);
}

// ─── SORT RULES ─────────────────────────────────────────────

export function fbAddSort() {
  const headers = this.APP.colHeaders[this.S.table] || [];
  const used = new Set((this.S.sorts || []).map(s => s.col));
  const col = headers.find(h => !used.has(h)) || headers[0] || '';
  const s = { id: newId(), col, dir: 'asc' };
  this.S.sorts = [...(this.S.sorts || []), s];
  this.S.showBuilder = true;
  rerender(this, `${s.id}:col`);
  this.applyFilterBar(true);
}

export function fbSetSort(id, field, value) {
  const s = (this.S.sorts || []).find(x => x.id === id);
  if (!s) return;
  s[field] = value;
  rerender(this, `${id}:${field}`);
  this.applyFilterBar(true);
}

export function fbRemoveSort(id) {
  this.S.sorts = (this.S.sorts || []).filter(s => s.id !== id);
  rerender(this);
  this.applyFilterBar(true);
}

/** Sort by one column only (from the right-click menus). */
export function fbSortBy(col, dir) {
  this.S.sorts = dir ? [{ id: newId(), col, dir }] : (this.S.sorts || []).filter(s => s.col !== col);
  rerender(this);
  this.applyFilterBar(true);
}

/** Add a ready-made condition (right-click "Show only…" / "Hide…") and apply it. */
export function addFilterFor(col, op, val = '', extra = {}) {
  const f = { ...newCondition(this, col), op, val: val === null ? '' : String(val), ...extra };
  this.S.filters = [...(this.S.filters || []), f];
  rerender(this);
  this.applyFilterBar(true);
}

/** Filter-row entries plus the filter bar's conditions that are filled in. */
export function completeFilters() {
  return (this.S.filters || []).filter(f => isQuick(f) || isComplete(this, f));
}

/** Number shown on the toolbar button: active conditions plus sort rules. */
export function filterBarCount() {
  return advanced(this).filter(f => f.active && isComplete(this, f)).length + (this.S.sorts || []).filter(s => s.col).length;
}

// ─── RENDER ─────────────────────────────────────────────────

function describe(app, f) {
  const kind = kindOf(app, f.col);
  const [, label, arity] = opInfo(kind, f.op);
  let value = '';
  if (arity === 2) value = `${f.val} and ${f.val2}`;
  else if (arity === 1) {
    if (kind === 'bool') value = String(f.val) === '1' ? 'true' : 'false';
    else if (kind === 'fk' && f.op !== 'fk') {
      const known = f.label || app.APP.fkLabels?.[app.S.table]?.[f.col]?.[String(f.val)];
      value = known && String(known) !== String(f.val) ? `${known} (${f.val})` : String(f.val);
    } else value = ['contains', 'not contains', 'starts with', 'ends with', 'fk'].includes(f.op) ? `“${f.val}”` : String(f.val);
  }
  return `${f.col} ${label}${value ? ' ' + value : ''}`;
}

function valueBox(app, f, kind, which) {
  const key = `${f.id}:${which}`;
  const val = String((which === 'val2' ? f.val2 : f.val) ?? '');
  const js = `window._dbm.fbSetVal('${escJs(f.id)}', '${which}', this.value`;
  if (kind === 'enum') {
    return `<select class="fbar-input" data-fkey="${key}" aria-label="Value" onchange="${js}, true)">
        <option value="" ${val === '' ? 'selected' : ''} disabled>choose…</option>
        ${enumValues(app, f.col).map(v => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select>`;
  }
  if (kind === 'bool') {
    return `<select class="fbar-input" data-fkey="${key}" aria-label="Value" onchange="${js}, true)">
        <option value="" ${val === '' ? 'selected' : ''} disabled>choose…</option>
        <option value="1" ${val === '1' ? 'selected' : ''}>true (1)</option>
        <option value="0" ${val === '0' ? 'selected' : ''}>false (0)</option>
      </select>`;
  }
  if (kind === 'fk' && f.op !== 'fk') {
    const name = f.label || app.APP.fkLabels?.[app.S.table]?.[f.col]?.[val];
    const shown = val === '' ? '<span class="fbar-ph">choose a row…</span>'
      : `<span class="fk-id">${esc(val)}</span>${name && String(name) !== val ? `<span class="fbar-fk-name">${esc(name)}</span>` : ''}`;
    return `<button type="button" class="fbar-input fbar-fk" data-fkey="${key}" aria-label="Choose a row"
        onclick="window._dbm.fbPickFk(this, '${escJs(f.id)}')">${shown}${ti('selector')}</button>`;
  }
  // DATETIME conditions compare the date part (fn "date") unless they came from
  // right-click "Show only <exact value>", which needs the full text.
  const type = kind === 'date' || (kind === 'datetime' && f.fn === 'date') ? 'date' : kind === 'time' ? 'time' : 'text';
  const extra = kind === 'number' ? 'inputmode="decimal"' : kind === 'time' ? 'step="1"' : '';
  const ph = kind === 'fk' ? 'part of the name…' : kind === 'number' ? 'number…' : 'value…';
  const commit = type === 'text' ? `oninput="${js})"` : `onchange="${js}, true)"`;
  return `<input class="fbar-input" type="${type}" ${extra} data-fkey="${key}" aria-label="Value"
      value="${esc(val)}" placeholder="${ph}" autocomplete="off" spellcheck="false" ${commit}
      onkeydown="if (event.key === 'Enter') window._dbm.applyFilterBar(true)">`;
}

/** The open filter bar. */
export function renderFilterBar(headers) {
  const conds = advanced(this);
  const match = this.S.filterMatch || 'all';
  const sorts = this.S.sorts || [];
  const colOptions = (selected) => headers.map(h => `<option value="${esc(h)}" ${h === selected ? 'selected' : ''}>${esc(h)}</option>`).join('');

  const rows = conds.map((f, i) => {
    const kind = kindOf(this, f.col);
    const arity = opInfo(kind, f.op)[2];
    const id = escJs(f.id);
    const join = i === 0
      ? '<span class="fbar-join">Where</span>'
      : `<button type="button" class="fbar-join fbar-join-btn" title="Click to switch between and / or"
           onclick="window._dbm.fbToggleMatch()">${match === 'any' ? 'or' : 'and'}</button>`;
    return `
      <div class="fbar-row ${isComplete(this, f) ? '' : 'incomplete'} ${f.active ? '' : 'off'}" role="group" aria-label="Condition ${i + 1}">
        <input type="checkbox" class="fbar-on" ${f.active ? 'checked' : ''} title="Turn this condition on or off"
               aria-label="Condition ${i + 1} on" onchange="window._dbm.fbToggle('${id}')">
        ${join}
        <select class="fbar-input fbar-col" data-fkey="${esc(f.id)}:col" aria-label="Column" onchange="window._dbm.fbSetCol('${id}', this.value)">${colOptions(f.col)}</select>
        <select class="fbar-input fbar-op" data-fkey="${esc(f.id)}:op" aria-label="Condition" onchange="window._dbm.fbSetOp('${id}', this.value)">
          ${opsFor(kind).map(([op, label]) => `<option value="${esc(op)}" ${op === f.op ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        ${arity >= 1 ? valueBox(this, f, kind, 'val') : ''}
        ${arity === 2 ? `<span class="fbar-and">and</span>${valueBox(this, f, kind, 'val2')}` : ''}
        <button type="button" class="fbar-del" title="Remove this condition" aria-label="Remove condition ${i + 1}"
                onclick="window._dbm.fbRemove('${id}')">${ti('x')}</button>
      </div>`;
  }).join('');

  const sortRows = sorts.map((s, i) => {
    const [up, down] = sortLabels(kindOf(this, s.col));
    const id = escJs(s.id);
    return `
      <span class="fbar-sort">
        ${i > 0 ? '<span class="fbar-then">then</span>' : ''}
        <select class="fbar-input" data-fkey="${esc(s.id)}:col" aria-label="Sort column" onchange="window._dbm.fbSetSort('${id}', 'col', this.value)">${colOptions(s.col)}</select>
        <select class="fbar-input" data-fkey="${esc(s.id)}:dir" aria-label="Sort direction" onchange="window._dbm.fbSetSort('${id}', 'dir', this.value)">
          <option value="asc" ${s.dir === 'asc' ? 'selected' : ''}>${up}</option>
          <option value="desc" ${s.dir === 'desc' ? 'selected' : ''}>${down}</option>
        </select>
        <button type="button" class="fbar-del" title="Remove this sort" aria-label="Remove sort ${i + 1}" onclick="window._dbm.fbRemoveSort('${id}')">${ti('x')}</button>
      </span>`;
  }).join('');

  const total = Number(this.S.totalRows || 0).toLocaleString();
  const active = conds.filter(f => f.active && isComplete(this, f)).length;
  return `
    <section class="fbar" aria-label="Filter and sort">
      <div class="fbar-head">
        <span class="fbar-title">${ti('filter')} Filter</span>
        <span class="fbar-count">${active ? `<strong>${total}</strong> matching ${total === '1' ? 'row' : 'rows'}` : 'Showing all rows'}</span>
        <span class="fbar-spacer"></span>
        ${conds.length || sorts.length ? '<button type="button" class="btn btn-sm" onclick="window._dbm.fbClearAll()">Clear all</button>' : ''}
        <button type="button" class="fbar-close" title="Close (filters stay on)" aria-label="Close the filter bar" onclick="window._dbm.toggleQueryBuilder()">${ti('x')}</button>
      </div>
      <div class="fbar-rows">${rows || '<div class="fbar-empty">No conditions. Tip: right-click any cell to filter by its value.</div>'}</div>
      <button type="button" class="fbar-add" onclick="window._dbm.fbAdd()">${ti('plus')} Add condition</button>
      <div class="fbar-sorts">
        <span class="fbar-sorts-label">${ti('arrows-sort')} Sort</span>
        ${sortRows || '<span class="fbar-ph">default order</span>'}
        <button type="button" class="fbar-add" onclick="window._dbm.fbAddSort()">${ti('plus')} Add sort</button>
      </div>
    </section>`;
}

/** When the bar is closed: one chip per active condition / sort. */
export function renderFilterChips() {
  const conds = advanced(this).filter(f => isComplete(this, f));
  const sorts = (this.S.sorts || []).filter(s => s.col);
  if (!conds.length && !sorts.length) return '';
  const match = this.S.filterMatch || 'all';
  const chips = conds.map((f, i) => `
    ${i > 0 ? `<span class="fchip-join">${match === 'any' ? 'or' : 'and'}</span>` : ''}
    <span class="fchip ${f.active ? '' : 'off'}">
      <button type="button" class="fchip-text" title="Edit filters" onclick="window._dbm.toggleQueryBuilder()">${ti('filter')}${esc(describe(this, f))}</button>
      <button type="button" class="fchip-x" title="Remove" aria-label="Remove filter ${esc(describe(this, f))}" onclick="window._dbm.fbRemove('${escJs(f.id)}')">${ti('x')}</button>
    </span>`).join('');
  const sortChips = sorts.map(s => {
    const [up, down] = sortLabels(kindOf(this, s.col));
    return `
      <span class="fchip fchip-sort">
        <button type="button" class="fchip-text" title="Edit sorting" onclick="window._dbm.toggleQueryBuilder()">${ti(s.dir === 'desc' ? 'sort-descending' : 'sort-ascending')}${esc(s.col)} ${s.dir === 'desc' ? down : up}</button>
        <button type="button" class="fchip-x" title="Remove" aria-label="Remove sort on ${esc(s.col)}" onclick="window._dbm.fbRemoveSort('${escJs(s.id)}')">${ti('x')}</button>
      </span>`;
  }).join('');
  return `
    <div class="fchips" aria-label="Active filters">
      ${chips}${sortChips}
      <button type="button" class="fchip-clear" onclick="window._dbm.fbClearAll()">Clear all</button>
    </div>`;
}

// ─── RIGHT-CLICK SHORTCUTS ──────────────────────────────────

const short = (v, n = 28) => (v.length > n ? v.slice(0, n - 1) + '…' : v);

export function onGridCellContextMenu(e) {
  const td = e.target.closest('td[data-col]');
  const tr = td?.closest('tr[data-row]');
  if (!td || !tr || td.querySelector('input, select')) return; // let editors keep their own menu
  e.preventDefault();
  const table = this.S.table;
  const ci = parseInt(td.dataset.col, 10);
  const ri = parseInt(tr.dataset.row, 10);
  const col = (this.APP.colHeaders[table] || [])[ci];
  const v = this.APP.tableData[table]?.[ri]?.[ci];
  const kind = kindOf(this, col);
  let shown = v === null || v === undefined ? 'NULL' : String(v);
  if (kind === 'fk' && v !== null) {
    const name = this.APP.fkLabels?.[table]?.[col]?.[String(v)];
    if (name && String(name) !== String(v)) shown = `${name} (${v})`;
  }
  shown = short(shown);
  const [up, down] = sortLabels(kind);

  const items = v === null || v === undefined
    ? [
      { label: `Show only rows where ${col} is NULL`, action: () => this.addFilterFor(col, 'is null') },
      { label: `Hide rows where ${col} is NULL`, action: () => this.addFilterFor(col, 'is not null') }
    ]
    : [
      { label: `Show only ${col} = ${shown}`, action: () => this.addFilterFor(col, '=', v, { fn: undefined }) },
      { label: `Hide ${col} = ${shown}`, action: () => this.addFilterFor(col, '!=', v, { fn: undefined }) },
      ...(kind === 'datetime' ? [{ label: `Show only ${String(v).slice(0, 10)} (whole day)`, action: () => this.addFilterFor(col, '=', String(v).slice(0, 10), { fn: 'date' }) }] : []),
      ...(kind === 'text' ? [{ label: `Show rows where ${col} contains…`, action: () => {
        this.S.filters = [...(this.S.filters || []), { ...newCondition(this, col), val: '' }];
        this.S.showBuilder = true;
        rerender(this, `${this.S.filters[this.S.filters.length - 1].id}:val`);
      } }] : [])
    ];
  items.push(
    '-',
    { label: `Sort by ${col}: ${up}`, action: () => this.fbSortBy(col, 'asc') },
    { label: `Sort by ${col}: ${down}`, action: () => this.fbSortBy(col, 'desc') },
    '-',
    { label: 'Copy Value', action: () => this.copyText(v === null || v === undefined ? 'NULL' : String(v), 'Value copied') }
  );
  this.showContextMenu(e.clientX, e.clientY, items);
}

export function onGridHeaderContextMenu(e, col) {
  e.preventDefault();
  const kind = kindOf(this, col);
  const [up, down] = sortLabels(kind);
  const sorted = (this.S.sorts || []).some(s => s.col === col);
  const filtered = advanced(this).some(f => f.col === col);
  this.showContextMenu(e.clientX, e.clientY, [
    { label: `Sort ${up}`, action: () => this.fbSortBy(col, 'asc') },
    { label: `Sort ${down}`, action: () => this.fbSortBy(col, 'desc') },
    ...(sorted ? [{ label: 'Remove Sort', action: () => this.fbSortBy(col, null) }] : []),
    '-',
    { label: `Filter ${col}…`, action: () => this.fbAdd(col, true) },
    ...(filtered ? [{ label: `Clear Filters on ${col}`, action: () => {
      this.S.filters = (this.S.filters || []).filter(f => isQuick(f) || f.col !== col);
      rerender(this);
      this.applyFilterBar(true);
    } }] : []),
    '-',
    { label: 'Copy Column Name', action: () => this.copyText(col, 'Name copied') }
  ]);
}
