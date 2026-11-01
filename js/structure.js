// The Structure tab: a table overview, the columns (key / foreign-key badges,
// comments under the name, a ⋯ menu per column for edit / insert / move / index /
// drop), indexes, foreign keys, and the tables that reference this one.
//
// Columns come from the Browse data load (APP.schemas), indexes from
// get_indexes (S.currentIndexes), and the rest from structure_info, cached per
// table in APP.structInfo and dropped whenever the table's data is reloaded.

import { esc, escJs, ti, TABLE_ICON } from './util.js';
import { formatBytes } from './export.js';

const infoKey = (app) => `${app.S.db}\u0000${app.S.table}`;

async function getJson(app, url) {
  const res = await fetch(url);
  if (res.status === 401) { app.handleSessionExpired(); throw new Error('Your session has expired.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function postJson(app, action, body) {
  const res = await fetch(`${app.apiUrl}?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (res.status === 401) { app.handleSessionExpired(); throw new Error('Your session has expired.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ─── DATA ───────────────────────────────────────────────────

export async function loadStructureInfo(force = false) {
  const k = infoKey(this);
  if (!this.APP.structInfo) this.APP.structInfo = {};
  const cur = this.APP.structInfo[k];
  if (cur && (cur.loading || (cur.loaded && !force))) return;
  this.APP.structInfo[k] = { ...(cur || {}), loading: true };
  try {
    const d = await getJson(this, `${this.apiUrl}?action=structure_info&db=${encodeURIComponent(this.S.db)}&table=${encodeURIComponent(this.S.table)}`);
    this.APP.structInfo[k] = { loaded: true, ...d };
  } catch (err) {
    this.APP.structInfo[k] = { loaded: true, error: err.message, status: {}, foreign_keys: [], referenced_by: [], create_sql: '' };
  }
  if (this.S.tab === 'structure' && infoKey(this) === k) this.renderPanel();
}

/** After a change: reload columns (which also drops the cached overview) and indexes. */
export async function refreshStructure() {
  this.S.currentIndexes = null;
  await this.loadTableDataFromServer(this.S.db, this.S.table);
}

// ─── RENDER ─────────────────────────────────────────────────

const typeCategory = (t) => {
  const s = String(t || '').toLowerCase();
  if (/\b(int|tinyint|smallint|mediumint|bigint|decimal|float|double|real|numeric)\b/.test(s)) return 'num';
  if (/\b(char|varchar|text|tinytext|mediumtext|longtext|blob)\b/.test(s)) return 'str';
  if (/\b(date|datetime|timestamp|time|year)\b/.test(s)) return 'date';
  if (/\b(bool|boolean|enum|set|json|bit|binary|varbinary)\b/.test(s)) return 'spec';
  return 'other';
};

const RULE_HELP = {
  CASCADE: 'follows the change (deletes / updates these rows too)',
  'SET NULL': 'clears the reference to NULL',
  RESTRICT: 'blocks the change while rows point to it',
  'NO ACTION': 'blocks the change while rows point to it',
  'SET DEFAULT': 'sets the column back to its default'
};
const ruleBadge = (r) => `<span class="st-rule st-rule-${esc(String(r).toLowerCase().replace(/\s+/g, '-'))}" title="${esc(RULE_HELP[r] || '')}">${esc(r)}</span>`;

/** Index membership per column: { col: [{ name, primary, unique }] } */
function indexesByColumn(rawIndexes) {
  const map = {};
  for (const r of rawIndexes || []) {
    (map[r.Column_name] ||= []).push({ name: r.Key_name, primary: r.Key_name === 'PRIMARY', unique: String(r.Non_unique) === '0' });
  }
  return map;
}

function groupIndexes(rawIndexes) {
  const groups = new Map();
  for (const r of rawIndexes || []) {
    if (!groups.has(r.Key_name)) {
      groups.set(r.Key_name, {
        name: r.Key_name, primary: r.Key_name === 'PRIMARY', unique: String(r.Non_unique) === '0',
        type: r.Index_type || 'BTREE', cardinality: r.Cardinality, columns: []
      });
    }
    const g = groups.get(r.Key_name);
    g.columns.push({ seq: r.Seq_in_index, name: r.Column_name, sub: r.Sub_part });
    if (r.Cardinality !== null && r.Cardinality !== undefined) g.cardinality = r.Cardinality;
  }
  return [...groups.values()];
}

export function renderStructurePanel(p, msgHtml) {
  const db = this.S.db;
  const table = this.S.table;
  const cols = this.APP.schemas[table] || [];
  const k = infoKey(this);

  if (!this.S.currentIndexes) this.loadIndexes();
  const info = this.APP.structInfo?.[k];
  if (!info) this.loadStructureInfo();

  const status = info?.status || {};
  const tableColl = status.collation || '';
  const idxByCol = indexesByColumn(this.S.currentIndexes);
  const groupedIdx = groupIndexes(this.S.currentIndexes);

  // Foreign key per column: from structure_info once loaded, otherwise from the Browse data.
  const fkByCol = {};
  if (info?.foreign_keys) {
    for (const fk of info.foreign_keys) {
      if (fk.columns.length === 1) fkByCol[fk.columns[0]] = { db: fk.ref_schema, table: fk.ref_table, column: fk.ref_columns[0], name: fk.name };
    }
  } else {
    for (const [c, m] of Object.entries(this.APP.fkMeta?.[table] || {})) fkByCol[c] = { db: m.schema, table: m.table, column: m.column };
  }

  const jsDb = escJs(db);
  const colRows = cols.map((c, i) => {
    const js = escJs(c.n);
    const idx = idxByCol[c.n] || [];
    const extra = String(c.extra || '').toLowerCase();
    const badges = [];
    if (idx.some(x => x.primary)) badges.push(`<span class="st-badge pk" title="Primary key">${ti('key')}PK</span>`);
    else if (idx.some(x => x.unique)) badges.push('<span class="st-badge uni" title="Unique index">UNIQUE</span>');
    else if (idx.length) badges.push(`<span class="st-badge idx" title="Indexed (${esc(idx.map(x => x.name).join(', '))})">INDEX</span>`);
    const fk = fkByCol[c.n];
    if (fk) {
      badges.push(`<button type="button" class="st-badge fk" title="References ${esc(fk.table)}.${esc(fk.column)}: click to open it"
          onclick="event.stopPropagation(); window._dbm.openObjectIn('${escJs(fk.db || db)}', '${escJs(fk.table)}', 'structure')">${ti('link')}${esc(fk.table)}.${esc(fk.column)}</button>`);
    }

    const attrs = [];
    if (extra.includes('auto_increment')) attrs.push('<span class="st-attr ai" title="Auto increment">auto increment</span>');
    if (/unsigned/i.test(c.t)) attrs.push('<span class="st-attr">unsigned</span>');
    if (extra.includes('on update')) attrs.push('<span class="st-attr" title="Set to the current time on every update">on update now</span>');
    if (/generated|virtual|stored/.test(extra)) attrs.push(`<span class="st-attr" title="${esc(c.extra)}">generated</span>`);
    if (c.collate && tableColl && c.collate !== tableColl) {
      attrs.push(`<span class="st-attr st-coll" title="Differs from the table's ${esc(tableColl)}">${esc(c.collate)}</span>`);
    }
    const typeText = String(c.t).replace(/\s+unsigned/i, '');

    let def;
    if (extra.includes('auto_increment')) def = '<span class="st-dim" title="Filled in automatically">auto</span>';
    else if (c.def === null) def = c.null ? '<span class="null-val">NULL</span>' : '<span class="st-dim" title="No default: a value must be given">—</span>';
    else if (/^current_timestamp/i.test(String(c.def))) def = `<code class="st-def st-def-fn">${esc(c.def)}</code>`;
    else def = `<code class="st-def">${esc(c.def === '' ? "''" : c.def)}</code>`;

    return `
      <tr class="struct-col-row st-row" data-col-name="${esc(c.n).toLowerCase()}" data-col-type="${esc(c.t).toLowerCase()}"
          ondblclick="window._dbm.openColumnEditor('${js}')" oncontextmenu="window._dbm.onStructColumnMenu(event, '${js}')">
        <td class="st-num">${i + 1}</td>
        <td class="st-name-cell">
          <div class="st-name-line"><strong class="st-col-name">${esc(c.n)}</strong>${badges.join('')}${c.comment ? `<span class="st-col-comment" title="${esc(c.comment)}">${esc(c.comment)}</span>` : ''}</div>
        </td>
        <td><span class="struct-type-pill cat-${typeCategory(c.t)}">${esc(typeText)}</span>${attrs.join('')}</td>
        <td>${c.null ? '<span class="st-yes">Yes</span>' : '<span class="st-no">No</span>'}</td>
        <td>${def}</td>
        <td class="st-actions">
          <button type="button" class="st-icon-btn" title="Edit column (or double-click the row)" aria-label="Edit ${esc(c.n)}"
                  onclick="window._dbm.openColumnEditor('${js}')">${ti('pencil')}</button>
          <button type="button" class="st-icon-btn" title="More actions" aria-label="More actions for ${esc(c.n)}"
                  onclick="window._dbm.onStructColumnMenu(event, '${js}')">${ti('dots')}</button>
        </td>
      </tr>`;
  }).join('');

  const stat = (label, value, title = '') =>
    `<div class="st-stat" ${title ? `title="${esc(title)}"` : ''}><span class="st-stat-label">${label}</span><span class="st-stat-value">${value}</span></div>`;
  const dash = '<span class="st-dim">—</span>';
  const loadingText = '<span class="st-dim">…</span>';

  const indexRows = groupedIdx.map(g => {
    const js = escJs(g.name);
    const badge = g.primary ? '<span class="idx-badge pk">PRIMARY</span>' : g.unique ? '<span class="idx-badge unique">UNIQUE</span>' : '<span class="idx-badge normal">INDEX</span>';
    return `
      <tr>
        <td><div class="idx-name-cell">${badge}<strong class="idx-keyname">${esc(g.name)}</strong></div></td>
        <td><div class="idx-cols-container">${g.columns.map(c => `<span class="idx-col-chip"><span class="idx-col-seq">${c.seq}</span><span class="idx-col-name">${esc(c.name)}${c.sub ? `(${esc(c.sub)})` : ''}</span></span>`).join('')}</div></td>
        <td><span class="idx-type-pill">${esc(g.type)}</span></td>
        <td class="st-num-right" title="Estimated number of distinct values">${g.cardinality !== null && g.cardinality !== undefined ? Number(g.cardinality).toLocaleString() : '—'}</td>
        <td class="st-actions">
          <button type="button" class="st-icon-btn" title="Edit index" onclick="window._dbm.openEditIndexModal('${js}')">${ti('pencil')}</button>
          <button type="button" class="st-icon-btn danger" title="${g.primary ? 'Drop the primary key' : 'Drop index'}" onclick="window._dbm.dropIndex('${js}')">${ti('trash')}</button>
        </td>
      </tr>`;
  }).join('');

  const fkRows = (info?.foreign_keys || []).map(fk => `
      <tr>
        <td><strong class="st-mono">${esc(fk.name)}</strong></td>
        <td class="st-mono">${fk.columns.map(esc).join(', ')}</td>
        <td><button type="button" class="st-link" onclick="window._dbm.openObjectIn('${escJs(fk.ref_schema)}', '${escJs(fk.ref_table)}', 'structure')">
          ${ti('link')}${fk.ref_schema !== db ? `${esc(fk.ref_schema)}.` : ''}${esc(fk.ref_table)} (${fk.ref_columns.map(esc).join(', ')})</button></td>
        <td>${ruleBadge(fk.on_delete)}</td>
        <td>${ruleBadge(fk.on_update)}</td>
        <td class="st-actions">
          <button type="button" class="st-icon-btn danger" title="Drop this foreign key" onclick="window._dbm.dropForeignKey('${escJs(fk.name)}')">${ti('trash')}</button>
        </td>
      </tr>`).join('');

  const refRows = (info?.referenced_by || []).map(fk => `
      <tr>
        <td><button type="button" class="st-link" onclick="window._dbm.openObjectIn('${escJs(fk.schema)}', '${escJs(fk.table)}', 'structure')">
          ${TABLE_ICON}${fk.schema !== db ? `${esc(fk.schema)}.` : ''}${esc(fk.table)}</button></td>
        <td class="st-mono">${fk.columns.map(esc).join(', ')} ${ti('arrow-right')} ${fk.ref_columns.map(esc).join(', ')}</td>
        <td>${ruleBadge(fk.on_delete)}</td>
        <td class="st-dim st-mono">${esc(fk.name)}</td>
      </tr>`).join('');

  p.innerHTML = `
    ${msgHtml}
    <section class="st-overview" aria-label="Table overview">
      <div class="st-head">
        <div class="st-title">
          ${TABLE_ICON}<h2>${esc(table)}</h2><span class="st-dim">in ${esc(db)}</span>
          ${status.comment ? `<span class="st-table-comment" title="Table comment">${ti('message')}${esc(status.comment)}</span>` : ''}
        </div>
        <div class="st-head-actions">
          <button type="button" class="btn" onclick="window._dbm.showCreateTable()" title="See or copy the full CREATE TABLE statement">${ti('code')} CREATE TABLE</button>
          <button type="button" class="btn" onclick="window._dbm.openAddForeignKey()">${ti('link')} Add Foreign Key</button>
          <button type="button" class="btn" onclick="window._dbm.openAddIndexModal()">${ti('bolt')} Add Index</button>
          <button type="button" class="btn primary" onclick="window._dbm.openColumnEditor(null)">${ti('plus')} Add Column</button>
        </div>
      </div>
      <div class="st-stats">
        ${stat('Columns', cols.length)}
        ${stat('Rows', info ? (status.rows === null || status.rows === undefined ? dash : `≈ ${Number(status.rows).toLocaleString()}`) : loadingText, 'Estimate from MySQL (exact for MyISAM)')}
        ${stat('Data', info ? formatBytes(status.data_length || 0) : loadingText)}
        ${stat('Indexes', info ? formatBytes(status.index_length || 0) : loadingText)}
        ${stat('Next ID', info ? (status.auto_increment ? Number(status.auto_increment).toLocaleString() : dash) : loadingText, 'Next AUTO_INCREMENT value')}
        ${stat('Engine', info ? esc(status.engine || '—') : loadingText)}
        ${stat('Collation', info ? esc(tableColl || '—') : loadingText, tableColl)}
        ${stat('Updated', info ? esc(status.update_time || status.create_time || '—') : loadingText, status.update_time ? `Last changed ${status.update_time}` : (status.create_time ? `Created ${status.create_time}` : ''))}
      </div>
    </section>

    <div class="st-section-head">
      <h3>${ti('columns')} Columns <span class="st-count">${cols.length}</span></h3>
      <div class="struct-filter-box">
        <span class="struct-filter-icon">${ti('search')}</span>
        <input type="search" id="struct-col-search" class="search-input struct-search-input" placeholder="Find a column…"
               aria-label="Find a column by name or type" oninput="window._dbm.filterStructureTable(this.value)" autocomplete="off" />
        <button id="struct-col-clear" class="struct-clear-btn" style="display:none;" onclick="window._dbm.clearStructureSearch()" title="Clear">${ti('x')}</button>
      </div>
    </div>
    <div class="tbl-wrapper st-table-wrap">
      <table class="data-tbl dgrid dgrid-bordered st-table">
        <thead><tr>
          <th class="st-num">#</th><th>Column</th><th>Type</th><th title="Can it be empty (NULL)?">Null</th><th>Default</th><th class="st-actions-h"><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody id="struct-table-body">
          ${colRows || '<tr><td colspan="6" class="st-empty">No columns.</td></tr>'}
          <tr id="struct-no-match-row" style="display:none;"><td colspan="6" class="st-empty">No column matches your search.</td></tr>
        </tbody>
      </table>
    </div>
    <p class="st-tip">${ti('info-circle')} Double-click a column to edit it. Right-click (or ⋯) to insert a column after it, move it, index it or link it to another table.</p>

    <div class="st-section-head">
      <h3>${ti('bolt')} Indexes <span class="st-count">${groupedIdx.length}</span></h3>
      <button type="button" class="btn btn-sm" onclick="window._dbm.openAddIndexModal()">${ti('plus')} Add Index</button>
    </div>
    <div class="tbl-wrapper st-table-wrap">
      <table class="data-tbl dgrid dgrid-bordered st-table">
        <thead><tr><th>Name</th><th>Columns</th><th>Type</th><th class="st-num-right">Cardinality</th><th class="st-actions-h"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${!this.S.currentIndexes ? '<tr><td colspan="5" class="st-empty">Loading…</td></tr>' : (indexRows || '<tr><td colspan="5" class="st-empty">No indexes. Index columns you filter or join on to make queries faster.</td></tr>')}</tbody>
      </table>
    </div>

    <div class="st-section-head">
      <h3>${ti('link')} Foreign Keys <span class="st-count">${info?.foreign_keys ? info.foreign_keys.length : '…'}</span></h3>
      <button type="button" class="btn btn-sm" onclick="window._dbm.openAddForeignKey()">${ti('plus')} Add Foreign Key</button>
    </div>
    <div class="tbl-wrapper st-table-wrap">
      <table class="data-tbl dgrid dgrid-bordered st-table">
        <thead><tr><th>Name</th><th>Column</th><th>References</th><th title="What happens to these rows when the referenced row is deleted">On delete</th><th title="…or when its key changes">On update</th><th class="st-actions-h"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${!info ? '<tr><td colspan="6" class="st-empty">Loading…</td></tr>'
          : info.error ? `<tr><td colspan="6" class="st-empty">${esc(info.error)}</td></tr>`
          : (fkRows || '<tr><td colspan="6" class="st-empty">No foreign keys. Link a column to another table so values must exist there, and the grid shows names instead of IDs.</td></tr>')}</tbody>
      </table>
    </div>

    <div class="st-section-head">
      <h3>${ti('arrow-back-up')} Referenced by <span class="st-count">${info?.referenced_by ? info.referenced_by.length : '…'}</span></h3>
    </div>
    <div class="tbl-wrapper st-table-wrap">
      <table class="data-tbl dgrid dgrid-bordered st-table">
        <thead><tr><th>Table</th><th>Column → ${esc(table)}</th><th>On delete</th><th>Constraint</th></tr></thead>
        <tbody>${!info ? '<tr><td colspan="4" class="st-empty">Loading…</td></tr>'
          : (refRows || '<tr><td colspan="4" class="st-empty">No other table points to this one.</td></tr>')}</tbody>
      </table>
    </div>`;
}

// ─── COLUMN MENU ────────────────────────────────────────────

export function onStructColumnMenu(e, col) {
  e.preventDefault();
  e.stopPropagation();
  const cols = (this.APP.schemas[this.S.table] || []).map(c => c.n);
  const i = cols.indexOf(col);
  const info = this.APP.structInfo?.[infoKey(this)];
  const idx = indexesByColumn(this.S.currentIndexes)[col] || [];
  const isPk = idx.some(x => x.primary);
  const fk = (info?.foreign_keys || []).find(f => f.columns.length === 1 && f.columns[0] === col);
  const x = e.clientX || e.target.getBoundingClientRect().left;
  const y = e.clientY || e.target.getBoundingClientRect().bottom;

  this.showContextMenu(x, y, [
    { label: 'Edit Column…', action: () => this.openColumnEditor(col) },
    { label: 'Insert Column After…', action: () => this.openColumnEditor(null, { after: col }) },
    '-',
    { label: 'Move Up', disabled: i <= 0, action: () => this.moveColumn(col, i >= 2 ? cols[i - 2] : '') },
    { label: 'Move Down', disabled: i < 0 || i >= cols.length - 1, action: () => this.moveColumn(col, cols[i + 1]) },
    { label: 'Move to Top', disabled: i <= 0, action: () => this.moveColumn(col, '') },
    '-',
    { label: 'Add Index', disabled: idx.length > 0, action: () => this.addIndex(col, 'INDEX') },
    { label: 'Add Unique Index', disabled: idx.some(x2 => x2.unique), action: () => this.addIndex(col, 'UNIQUE') },
    fk
      ? { label: `Open ${fk.ref_table}`, action: () => this.openObjectIn(fk.ref_schema, fk.ref_table, 'structure') }
      : { label: 'Link to Another Table…', action: () => this.openAddForeignKey(col) },
    '-',
    { label: 'Copy Name', action: () => this.copyText(col, 'Name copied') },
    '-',
    { label: 'Drop Column…', danger: true, disabled: isPk, action: () => this.dropColumn(col) }
  ]);
}

export async function moveColumn(col, after) {
  try {
    await postJson(this, 'move_column', { db: this.S.db, table: this.S.table, column: col, after });
    this.showMsg(after ? `Moved ${col} after ${after}` : `Moved ${col} to the top`);
    await this.refreshStructure();
  } catch (err) {
    this.showAlertDialog(`Could not move ${col}`, err.message, 'error');
  }
}

// ─── CREATE TABLE ───────────────────────────────────────────

export async function showCreateTable() {
  let sql = this.APP.structInfo?.[infoKey(this)]?.create_sql;
  try {
    if (!sql) {
      const d = await getJson(this, `${this.apiUrl}?action=show_create&db=${encodeURIComponent(this.S.db)}&kind=table&name=${encodeURIComponent(this.S.table)}`);
      sql = d.sql;
    }
  } catch (err) {
    return this.showAlertDialog('Could not read the table definition', err.message, 'error');
  }
  const copy = await this.confirmDialog({
    type: 'info', icon: 'code', wide: true,
    title: `CREATE TABLE ${this.S.table}`,
    details: `${sql};`,
    confirmText: 'Copy', cancelText: 'Close'
  });
  if (copy) this.copyText(`${sql};`, 'CREATE TABLE copied');
}

// ─── FOREIGN KEYS ───────────────────────────────────────────

const RULE_OPTIONS = [
  { value: 'RESTRICT', label: 'RESTRICT: block it while rows point to it' },
  { value: 'CASCADE', label: 'CASCADE: do the same to these rows' },
  { value: 'SET NULL', label: 'SET NULL: clear the reference' },
  { value: 'NO ACTION', label: 'NO ACTION: same as RESTRICT in InnoDB' }
];

/** Guess the referenced table from a column name: branch_id → branches / branch. */
function guessRefTable(col, tables) {
  const base = String(col || '').replace(/_?id$/i, '');
  if (!base) return '';
  const candidates = [`${base}s`, `${base}es`, base.replace(/y$/i, 'ies'), base];
  return candidates.find(c => tables.includes(c)) || '';
}

async function columnOptions(app, table) {
  if (!table) return { options: [], pick: '' };
  const d = await getJson(app, `${app.apiUrl}?action=table_columns&db=${encodeURIComponent(app.S.db)}&table=${encodeURIComponent(table)}`);
  const cols = d.columns || [];
  const pk = cols.find(c => c.key === 'PRI') || cols.find(c => c.key === 'UNI') || cols[0];
  return {
    options: cols.map(c => ({ value: c.name, label: `${c.name}  (${c.type}${c.key === 'PRI' ? ', primary key' : c.key === 'UNI' ? ', unique' : ''})` })),
    pick: pk ? pk.name : ''
  };
}

export async function openAddForeignKey(col = null) {
  const db = this.S.db;
  const table = this.S.table;
  const cols = (this.APP.schemas[table] || []).map(c => c.n);
  const views = new Set(this.APP.databases[db]?.views || []);
  const tables = (this.APP.databases[db]?.tables || []).filter(t => !views.has(t));
  const fromCol = col || cols.find(c => /_id$/i.test(c) && !this.APP.fkMeta?.[table]?.[c]) || cols[0];
  const refTable = guessRefTable(fromCol, tables) || tables[0] || '';

  let first;
  try {
    first = await columnOptions(this, refTable);
  } catch (err) {
    return this.showAlertDialog('Could not load columns', err.message, 'error');
  }

  const values = await this.formDialog({
    title: `Link ${table} to another table`,
    message: 'Values in the column must then exist in the referenced column. The grid will also show names instead of bare IDs.',
    type: 'primary', icon: 'link', wide: true, confirmText: 'Add Foreign Key',
    fields: [
      { name: 'column', label: `Column in ${table}`, type: 'select', options: cols, value: fromCol, required: true },
      { name: 'ref_table', label: 'References table', type: 'select', options: tables, value: refTable, required: true },
      { name: 'ref_column', label: 'Referenced column', type: 'select', options: first.options, value: first.pick, required: true,
        hint: 'Usually the other table’s primary key. It must be indexed and of the same type.' },
      { name: 'on_delete', label: 'When the referenced row is deleted', type: 'select', options: RULE_OPTIONS, value: 'RESTRICT' },
      { name: 'on_update', label: 'When its key changes', type: 'select', options: RULE_OPTIONS, value: 'CASCADE' },
      { name: 'name', label: 'Constraint name (optional)', type: 'text', placeholder: 'leave empty for an automatic name' }
    ],
    onFieldChange: async (name, value, api) => {
      if (name === 'column') {
        const guess = guessRefTable(value, tables);
        if (guess && guess !== api.get('ref_table')) { api.setValue('ref_table', guess); name = 'ref_table'; value = guess; }
      }
      if (name === 'ref_table') {
        api.setOptions('ref_column', [{ value: '', label: 'Loading…' }], '');
        try {
          const r = await columnOptions(this, value);
          api.setOptions('ref_column', r.options, r.pick);
        } catch (err) {
          api.setOptions('ref_column', [{ value: '', label: err.message }], '');
        }
      }
    }
  });
  if (!values) return;

  try {
    await postJson(this, 'add_foreign_key', {
      db, table, columns: [values.column], ref_table: values.ref_table, ref_columns: [values.ref_column],
      on_delete: values.on_delete, on_update: values.on_update, name: values.name.trim()
    });
    this.showMsg(`Linked ${table}.${values.column} to ${values.ref_table}.${values.ref_column}`);
    await this.refreshStructure();
  } catch (err) {
    let hint = '';
    if (/\b1452\b/.test(err.message)) hint = `\n\nSome rows in ${table} have a ${values.column} that doesn't exist in ${values.ref_table}. Fix or clear those values first (the Browse tab marks them "not found" once linked).`;
    else if (/\b(3780|1215|150)\b/.test(err.message)) hint = '\n\nThe two columns must have the same type (including UNSIGNED and length), and the referenced column must be indexed.';
    this.showAlertDialog('Could not add the foreign key', err.message + hint, 'error');
  }
}

export async function dropForeignKey(name) {
  const ok = await this.confirmDialog({
    type: 'danger', title: `Drop foreign key "${name}"?`, confirmText: 'Drop',
    message: 'The link is removed; no data is deleted. The column keeps its index.'
  });
  if (!ok) return;
  try {
    await postJson(this, 'drop_foreign_key', { db: this.S.db, table: this.S.table, name });
    this.showMsg(`Dropped foreign key ${name}`);
    await this.refreshStructure();
  } catch (err) {
    this.showAlertDialog('Could not drop the foreign key', err.message, 'error');
  }
}
