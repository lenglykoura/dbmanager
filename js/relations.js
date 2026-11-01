// Relationship (foreign-key) columns in the Browse grid: how their cells show the
// referenced row's name, the searchable picker used to edit and filter them, and
// jumping to the row a value points at.
//
// The server sends, per table: fk_meta  { col: { schema, table, column, label } }
// and fk_labels { col: { value: name } } for the values on the current page. A
// value missing from fk_labels points at a row that does not exist (an orphan).

import { esc, escJs, ti } from './util.js';

/** FK target of a column of the current table, or undefined. */
export function fkMetaFor(colName, table = this.S.table) {
  return this.APP.fkMeta?.[table]?.[colName];
}

/** Grid cell for a relationship column: ID pill, referenced name, jump + edit affordances. */
export function renderFkCell(colName, value, rowIndex, colIndex, align) {
  const meta = this.fkMetaFor(colName);
  const labels = this.APP.fkLabels?.[this.S.table]?.[colName];
  const jsCol = escJs(colName);

  let body;
  if (value === null || value === undefined) {
    body = '<span class="null-val">NULL</span>';
  } else {
    const key = String(value);
    const known = labels && Object.prototype.hasOwnProperty.call(labels, key);
    const showName = known && meta.label && labels[key] !== null && String(labels[key]) !== key;
    body = `<span class="fk-id">${esc(value)}</span>`;
    if (showName) {
      body += `<span class="fk-label">${esc(labels[key])}</span>`;
    } else if (labels && !known) {
      // Only flagged when the server looked the value up and found nothing.
      body += `<span class="fk-missing" title="No row in ${esc(meta.table)} has ${esc(meta.column)} = ${esc(value)}">${ti('alert-triangle')} not found</span>`;
    }
  }

  const jump = value === null || value === undefined ? '' :
    `<button type="button" class="fk-jump" title="Open ${esc(meta.table)} where ${esc(meta.column)} = ${esc(value)}"
       onclick="event.stopPropagation(); window._dbm.jumpToFk('${jsCol}', '${escJs(value)}')">${ti('arrow-up-right')}</button>`;

  return `<td class="fk-cell-td" data-col="${colIndex}" style="text-align:${align};">
      <div class="fk-cell-view" onclick="window._dbm.openFkCellPicker(this, ${rowIndex}, ${colIndex})"
           title="${esc(meta.table)}.${esc(meta.column)} · click to change">
        <span class="fk-cell-text">${body}</span>
        <span class="fk-cell-tools">${jump}<span class="fk-cell-arrow">${ti('selector')}</span></span>
      </div>
    </td>`;
}

/** Small link icon for a relationship column's header. */
export function fkHeaderBadge(colName) {
  const meta = this.fkMetaFor(colName);
  if (!meta) return '';
  const shows = meta.label ? `, shows ${meta.label}` : '';
  return `<span class="th-fk" title="References ${esc(meta.table)}.${esc(meta.column)}${esc(shows)}">${ti('link')}</span>`;
}

/** Filter-row input for a relationship column: free text (ID or name) plus a picker button. */
export function renderFkFilterCell(colName) {
  const meta = this.fkMetaFor(colName);
  const current = this.S.colFilters?.[colName] || '';
  const jsCol = escJs(colName);
  return `
    <div class="col-filter-box has-pick">
      <input class="col-filter-inp"
             id="col-filter-${esc(colName)}"
             value="${esc(current)}"
             placeholder="ID or ${esc(meta.label || meta.column)}…"
             title="Type an ID or part of the ${esc(meta.label || meta.column)}. Use =5 for an exact ID, NULL for empty."
             onkeydown="if(event.key === 'Enter') { window._dbm.applyColumnFilters(); }"
             oninput="window._dbm.setColumnFilter('${jsCol}', this.value)" />
      <button type="button" class="col-filter-pick" title="Pick a ${esc(meta.table)} row"
              onclick="window._dbm.openFkFilterPicker(this.parentNode, '${jsCol}')">${ti('list-search')}</button>
      ${current ? `<button class="col-filter-clear-btn" onclick="window._dbm.clearSingleColumnFilter('${jsCol}')">${ti('x')}</button>` : ''}
    </div>`;
}

// ─── ACTIONS ────────────────────────────────────────────────

/** Edit a grid cell through the picker. */
export function openFkCellPicker(el, rowIndex, colIndex) {
  const table = this.S.table;
  const colDef = (this.APP.schemas[table] || [])[colIndex];
  if (!colDef) return;
  const td = el.closest('td') || el;
  const current = this.APP.tableData[table]?.[rowIndex]?.[colIndex];

  td.classList.add('fk-editing');
  this.openFkPicker(td, {
    table,
    column: colDef.n,
    current,
    nullable: colDef.null,
    freeText: (q) => `Use “${q}” as the ${this.fkMetaFor(colDef.n).column}`,
    onClose: () => td.classList.remove('fk-editing')
  }, async (pick) => {
    if (pick.val !== null && !pick.free) {
      const labels = ((this.APP.fkLabels ||= {})[table] ||= {});
      (labels[colDef.n] ||= {})[String(pick.val)] = pick.label;
    }
    await this.saveCell(rowIndex, colIndex, { tagName: 'SELECT', value: pick.val === null ? '' : String(pick.val) });
    // A typed-in ID has no known name yet: reload so the cell shows it.
    if (pick.free) this.loadTableDataFromServer(this.S.db, table);
  });
}

/** Filter a column by picking a referenced row (or NULL, or free text). */
export function openFkFilterPicker(anchor, colName) {
  const meta = this.fkMetaFor(colName);
  this.openFkPicker(anchor, {
    table: this.S.table,
    column: colName,
    current: undefined,
    nullable: true,
    allowText: !!meta.label,
    freeText: (q) => `Rows whose ${meta.label || meta.column} contains “${q}”`
  }, (pick) => {
    if (!this.S.colFilters) this.S.colFilters = {};
    this.S.colFilters[colName] = pick.free ? pick.val : (pick.val === null ? 'NULL' : `=${pick.val}`);
    this.applyColumnFilters();
  });
}

/** Choose a value for a relationship field in the Insert Row form. */
export function openInsertFkPicker(btn, colName) {
  const hidden = document.getElementById(btn.dataset.target);
  const col = (this.APP.schemas[this.S.table] || []).find(c => c.n === colName);
  if (!hidden || !col) return;
  this.openFkPicker(btn, {
    table: this.S.table,
    column: colName,
    current: hidden.dataset.empty === '1' ? undefined : (hidden.value === '' ? null : hidden.value),
    nullable: col.null,
    freeText: (q) => `Use “${q}” as the ${this.fkMetaFor(colName).column}`
  }, (pick) => {
    hidden.value = pick.val === null ? '' : String(pick.val);
    hidden.dataset.empty = '0';
    const text = btn.querySelector('.fk-field-text');
    if (pick.val === null) {
      text.innerHTML = '<span class="null-val">NULL</span>';
    } else {
      const name = !pick.free && pick.label !== null && String(pick.label) !== String(pick.val) ? pick.label : '';
      text.innerHTML = `<span class="fk-id">${esc(pick.val)}</span>${name ? `<span class="fk-label">${esc(name)}</span>` : ''}`;
    }
    btn.focus();
  });
}

/** Open the referenced table filtered to the row this value points at. */
export function jumpToFk(colName, value) {
  const meta = this.fkMetaFor(colName);
  if (!meta) return;
  this.S.showFilterRow = true;
  this.S.tab = 'browse';
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.id === 'tab-browse'));
  this.selectTable(meta.schema, meta.table, { [meta.column]: `=${value}` });
  this.showMsg(`Opened ${meta.table} where ${meta.column} = ${value}`);
}

// ─── PICKER ─────────────────────────────────────────────────

/**
 * Searchable list of the rows a relationship column can point at, anchored to
 * an element. Results come from the server (50 at a time) as you type.
 *
 * opts: { table, column, current, nullable, freeText(q) => label|null, allowText, onClose }
 * onPick({ val, label, free }) — val null means NULL; free means typed text.
 */
export function openFkPicker(anchor, opts, onPick) {
  this.closeFkPicker();
  const meta = this.fkMetaFor(opts.column, opts.table);
  if (!meta) return;

  const pop = document.createElement('div');
  pop.id = 'dbm-fk-picker';
  pop.className = 'fkp';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Choose ${meta.table} row`);
  pop.innerHTML = `
    <div class="fkp-head">
      ${ti('link')}
      <span class="fkp-target">${esc(meta.table)}<span class="fkp-dim">.${esc(meta.column)}</span></span>
      ${meta.label ? `<span class="fkp-dim fkp-shows">shows ${esc(meta.label)}</span>` : ''}
    </div>
    <div class="fkp-search">
      ${ti('search')}
      <input type="text" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="fkp-list"
             placeholder="Search ${esc(meta.label ? `${meta.label} or ${meta.column}` : meta.column)}…">
    </div>
    <div class="fkp-list" id="fkp-list" role="listbox"></div>
    <div class="fkp-foot"><span class="fkp-status"></span><span class="fkp-keys">↑↓ Enter · Esc</span></div>`;
  document.body.appendChild(pop);

  const input = pop.querySelector('input');
  const list = pop.querySelector('.fkp-list');
  const status = pop.querySelector('.fkp-status');
  const state = { q: '', options: [], hasMore: false, items: [], active: 0, loading: true, error: '' };
  const hasCurrent = opts.current !== undefined;

  const position = () => {
    const r = anchor.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    const h = pop.offsetHeight;
    const below = r.bottom + 4;
    pop.style.top = `${below + h > window.innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 : below}px`;
  };

  const build = () => {
    const q = state.q;
    const items = [];
    if (opts.nullable && !q) items.push({ val: null, label: null });
    state.options.forEach(o => items.push({ val: o.val, label: o.label }));
    const exact = state.options.some(o => String(o.val) === q);
    // Offer the typed text as a raw value only when it could be one. Filter
    // mode (allowText) takes any text, since it searches names.
    const plausible = opts.allowText || !meta.numeric || /^-?\d+(\.\d+)?$/.test(q);
    const free = q && !exact && plausible && opts.freeText ? opts.freeText(q) : null;
    if (free) items.push({ val: q, label: free, free: true });
    state.items = items;

    const curIdx = hasCurrent ? items.findIndex(it => !it.free && (it.val === null ? opts.current === null : String(it.val) === String(opts.current))) : -1;
    state.active = q ? 0 : Math.max(0, curIdx);

    list.innerHTML = items.length ? items.map((it, i) => {
      const isCur = hasCurrent && i === curIdx;
      let inner;
      if (it.free) inner = `${ti('corner-down-left')}<span class="fkp-text">${esc(it.label)}</span>`;
      else if (it.val === null) inner = '<span class="null-val">NULL</span><span class="fkp-text fkp-dim">no reference</span>';
      else {
        const name = meta.label && it.label !== null && String(it.label) !== String(it.val) ? it.label : '';
        inner = `<span class="fk-id">${esc(it.val)}</span><span class="fkp-text">${name ? esc(name) : '<span class="fkp-dim">—</span>'}</span>`;
      }
      return `<div class="fkp-opt${i === state.active ? ' active' : ''}${isCur ? ' current' : ''}${it.free ? ' free' : ''}"
                   role="option" id="fkp-opt-${i}" data-i="${i}" aria-selected="${i === state.active}">
                ${inner}${isCur ? `<span class="fkp-check">${ti('check')}</span>` : ''}
              </div>`;
    }).join('') : `<div class="fkp-empty">${state.loading ? 'Loading…' : (state.error ? '' : `No ${esc(meta.table)} rows match.`)}</div>`;

    status.classList.toggle('err', !!state.error);
    status.textContent = state.error ? state.error
      : state.loading ? 'Searching…'
      : state.hasMore ? `First ${state.options.length} shown, type to narrow down`
      : `${state.options.length} ${state.options.length === 1 ? 'row' : 'rows'}`;
    input.setAttribute('aria-activedescendant', items.length ? `fkp-opt-${state.active}` : '');
    list.querySelector('.fkp-opt.active')?.scrollIntoView({ block: 'nearest' });
    position();
  };

  const setActive = (i) => {
    if (!state.items.length) return;
    state.active = (i + state.items.length) % state.items.length;
    list.querySelectorAll('.fkp-opt').forEach(el => {
      const on = Number(el.dataset.i) === state.active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on);
    });
    input.setAttribute('aria-activedescendant', `fkp-opt-${state.active}`);
    list.querySelector('.fkp-opt.active')?.scrollIntoView({ block: 'nearest' });
  };

  let seq = 0;
  const load = async (q) => {
    const mine = ++seq;
    state.loading = true;
    state.error = '';
    build();
    try {
      const url = `${this.apiUrl}?action=fk_options&db=${encodeURIComponent(this.S.db)}`
        + `&table=${encodeURIComponent(opts.table)}&column=${encodeURIComponent(opts.column)}&q=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      if (res.status === 401) { close(); this.handleSessionExpired(); return; }
      const data = await res.json();
      if (mine !== seq) return; // a newer search is on its way
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not load options');
      state.options = data.options || [];
      state.hasMore = !!data.has_more;
    } catch (err) {
      if (mine !== seq) return;
      state.options = [];
      state.error = err.message;
    }
    state.loading = false;
    build();
  };

  const choose = (i) => {
    const it = state.items[i];
    if (!it) return;
    close();
    onPick(it);
  };

  let timer = null;
  input.addEventListener('input', () => {
    state.q = input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => load(state.q), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(state.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(state.active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!state.loading || state.items.length) choose(state.active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close();
  });
  list.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.fkp-opt');
    if (!opt) return;
    e.preventDefault();
    choose(Number(opt.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const opt = e.target.closest('.fkp-opt');
    if (opt && Number(opt.dataset.i) !== state.active) setActive(Number(opt.dataset.i));
  });

  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onScroll = (e) => { if (!pop.contains(e.target)) close(); };
  const close = () => {
    clearTimeout(timer);
    seq++;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    pop.remove();
    this._fkPickerClose = null;
    if (opts.onClose) opts.onClose();
  };
  this._fkPickerClose = close;
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
  });

  build();
  input.focus();
  load('');
}

export function closeFkPicker() {
  if (this._fkPickerClose) this._fkPickerClose();
}
