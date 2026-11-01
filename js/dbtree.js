// The sidebar tree under each database, Navicat style: Tables, Views, Functions
// (procedures + functions), Triggers, Events, Queries and Backups folders, plus
// what clicking or right-clicking the items in them does.
//
// - Tables / Views come from the database list the app already loads.
// - Functions / Triggers / Events load from `db_objects` when a database is expanded.
// - Queries are saved SQL kept in this browser (localStorage), per connection.
// - Backups are .sql dumps the server keeps outside the web root.

import { esc, escJs, ti, TABLE_ICON, VIEW_ICON } from './util.js';
import { formatBytes } from './export.js';

const FOLDER_STATE_KEY = 'dbm_folders';
const QUERIES_KEY = 'dbm_queries';

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

async function getJson(app, url) {
  const res = await fetch(url);
  if (res.status === 401) {
    app.handleSessionExpired();
    throw new Error('Your session has expired.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function postJson(app, action, body) {
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

// ─── FOLDER STATE ───────────────────────────────────────────

function folderKey(db, folder) {
  return `${db}\u0000${folder}`;
}

/** Tables and Pinned start open (as the flat list used to be); everything else closed. */
export function isFolderOpen(db, folder) {
  if (!this._folderState) this._folderState = readJson(FOLDER_STATE_KEY, {});
  const v = this._folderState[folderKey(db, folder)];
  return v === undefined ? (folder === 'tables' || folder === 'pinned') : !!v;
}

export function toggleFolder(db, folder) {
  const sel = `[data-db="${CSS.escape(db)}"][data-folder="${folder}"]`;
  this.toggleTreeBranch(`.tree-children${sel}`, `.tree-folder${sel}`, this.isFolderOpen(db, folder), () => {
    if (!this._folderState) this._folderState = readJson(FOLDER_STATE_KEY, {});
    this._folderState[folderKey(db, folder)] = !this.isFolderOpen(db, folder);
    writeJson(FOLDER_STATE_KEY, this._folderState);
  });
}

// ─── SMOOTH OPEN / CLOSE ────────────────────────────────────

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Slide an element open (0 → its height) or closed. Resolves when done. */
function slide(el, opening) {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return Promise.resolve();
  const h = el.scrollHeight;
  if (!h) return Promise.resolve();
  el.style.overflow = 'hidden';
  const frames = opening
    ? [{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }]
    : [{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }];
  // Longer lists get a little more time, capped so big databases still feel quick.
  const duration = Math.min(260, 140 + h / 12);
  const anim = el.animate(frames, { duration, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
  // Browsers pause animations in background tabs; never let the tree wait on one.
  const timeout = new Promise(resolve => setTimeout(resolve, duration + 120));
  return Promise.race([anim.finished.catch(() => {}), timeout]).then(() => {
    anim.cancel();
    el.style.overflow = '';
  });
}

/**
 * Open or close one branch of the sidebar tree (a database or a folder) with a
 * slide. `commit` flips the stored open/closed state; the tree is then
 * re-rendered. Closing slides the old branch shut first; opening renders it and
 * slides it open, and the header's arrow rotates either way.
 */
export async function toggleTreeBranch(childSelector, headerSelector, isOpen, commit) {
  if (this._treeAnimating) return; // ignore clicks while a branch is sliding shut
  const root = document.getElementById('sidebar-content');
  if (isOpen) {
    this._treeAnimating = true;
    root?.querySelector(headerSelector)?.classList.remove('open');
    await slide(root?.querySelector(childSelector), false);
    this._treeAnimating = false;
    commit();
    this.renderSidebar();
  } else {
    commit();
    this.renderSidebar();
    const header = root?.querySelector(headerSelector);
    if (header && !reducedMotion()) {
      // Re-render drew the arrow already turned; restart it so it rotates.
      header.classList.remove('open');
      void header.offsetWidth;
      header.classList.add('open');
    }
    slide(root?.querySelector(childSelector), true);
  }
}

/** Load a database's routines/triggers/events and backups before it's expanded. */
export function prefetchDbTree(db) {
  if (!this.APP.dbObjects?.[db]) this.loadDbObjects(db);
  if (!this.APP.backups?.[db]) this.loadBackups(db);
}

// ─── PINS ───────────────────────────────────────────────────

const PINS_KEY = 'dbm_pins';

/** Pinned databases ({ db }) and tables ({ db, table }) for this connection, in pin order. */
export function pins() {
  return readJson(PINS_KEY, {})[connKey(this)] || [];
}

export function isPinned(db, table = null) {
  return this.pins().some(p => p.db === db && (p.table ?? null) === table);
}

export function togglePin(db, table = null) {
  const list = this.pins();
  const i = list.findIndex(p => p.db === db && (p.table ?? null) === table);
  if (i >= 0) list.splice(i, 1);
  else list.push(table === null ? { db } : { db, table });
  const all = readJson(PINS_KEY, {});
  all[connKey(this)] = list;
  writeJson(PINS_KEY, all);
  this.renderSidebar();
}

/** Small pin toggle shown on hover (and always, filled, once pinned). */
export function pinButtonHtml(db, table = null) {
  const pinned = this.isPinned(db, table);
  const what = table === null ? `database ${db}` : `table ${table}`;
  const args = `'${escJs(db)}'${table === null ? '' : `, '${escJs(table)}'`}`;
  return `<button type="button" class="pin-btn ${pinned ? 'pinned' : ''}" aria-pressed="${pinned}"
      title="${pinned ? 'Unpin' : 'Pin'} ${esc(what)}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(what)}"
      onclick="event.stopPropagation(); window._dbm.togglePin(${args})">${ti(pinned ? 'pinned-filled' : 'pin')}</button>`;
}

/** The "Pinned" section at the top of the sidebar. */
export function renderPinnedSection(filterLower) {
  const dbs = this.APP.databases || {};
  // Skip pins whose database or table no longer exists (they stay stored, in case it comes back).
  const items = this.pins().filter(p => dbs[p.db] && (p.table === undefined || (dbs[p.db].tables || []).includes(p.table)));
  const shown = items.filter(p => !filterLower || `${p.db} ${p.table || ''}`.toLowerCase().includes(filterLower));
  if (!shown.length) return '';
  const open = filterLower ? true : this.isFolderOpen('', 'pinned');

  const rows = shown.map(p => {
    const jsDb = escJs(p.db);
    if (p.table === undefined) {
      return `
        <div class="tbl-row pin-row ${this.S.db === p.db && !this.S.table ? 'active' : ''}"
             onclick="window._dbm.handleDbRowClick('${jsDb}')"
             oncontextmenu="window._dbm.onDbContextMenu(event, '${jsDb}')" title="Database ${esc(p.db)}">
          ${ti('database')}<span class="tbl-name">${esc(p.db)}</span>${this.pinButtonHtml(p.db)}
        </div>`;
    }
    const isView = (dbs[p.db].views || []).includes(p.table);
    return `
      <div class="tbl-row pin-row ${this.S.db === p.db && this.S.table === p.table ? 'active' : ''} ${isView ? 'is-view' : ''}"
           onclick="window._dbm.selectTable('${jsDb}', '${escJs(p.table)}')"
           oncontextmenu="window._dbm.onTableContextMenu(event, '${jsDb}', '${escJs(p.table)}')"
           title="${esc(p.db)}.${esc(p.table)}">
        ${isView ? VIEW_ICON : TABLE_ICON}<span class="tbl-name">${esc(p.table)}</span>
        <span class="tree-meta">${esc(p.db)}</span>${this.pinButtonHtml(p.db, p.table)}
      </div>`;
  }).join('');

  return `
    <div class="pinned-section">
      <div class="tree-folder pinned-header ${open ? 'open' : ''}" data-db="" data-folder="pinned" role="treeitem" aria-expanded="${open}"
           onclick="window._dbm.toggleFolder('', 'pinned')">
        <span class="tree-arrow">${ti('chevron-right')}</span>
        ${ti('pinned')}
        <span class="tree-folder-name">Pinned</span>
        <span class="tree-count">${shown.length}</span>
      </div>
      ${open ? `<div class="tree-children pinned-list" data-db="" data-folder="pinned">${rows}</div>` : ''}
    </div>`;
}

// ─── LOADING ────────────────────────────────────────────────

/** Procedures, functions, triggers and events of a database (cached). */
export async function loadDbObjects(db, force = false) {
  if (!this.APP.dbObjects) this.APP.dbObjects = {};
  const cur = this.APP.dbObjects[db];
  if (cur && (cur.loading || (cur.loaded && !force))) return;
  this.APP.dbObjects[db] = { ...(cur || {}), loading: true };
  try {
    const data = await getJson(this, `${this.apiUrl}?action=db_objects&db=${encodeURIComponent(db)}`);
    this.APP.dbObjects[db] = { loaded: true, routines: data.routines || [], triggers: data.triggers || [], events: data.events || [] };
  } catch (err) {
    this.APP.dbObjects[db] = { loaded: true, error: err.message, routines: [], triggers: [], events: [] };
  }
  this.renderSidebar();
}

export async function loadBackups(db, force = false) {
  if (!this.APP.backups) this.APP.backups = {};
  const cur = this.APP.backups[db];
  if (cur && (cur.loading || (cur.loaded && !force))) return;
  this.APP.backups[db] = { ...(cur || {}), loading: true };
  try {
    const data = await getJson(this, `${this.apiUrl}?action=backup_list&db=${encodeURIComponent(db)}`);
    this.APP.backups[db] = { loaded: true, list: data.backups || [], dir: data.dir };
  } catch (err) {
    this.APP.backups[db] = { loaded: true, list: [], error: err.message };
  }
  this.renderSidebar();
}

// ─── RENDER ─────────────────────────────────────────────────

/** Everything shown under an expanded database in the sidebar. */
export function renderDbFolders(db, info, filterLower) {
  // Fetch the non-table objects and backups the first time a database is opened.
  if (!this.APP.dbObjects?.[db]) setTimeout(() => this.loadDbObjects(db));
  if (!this.APP.backups?.[db]) setTimeout(() => this.loadBackups(db));

  const jsDb = escJs(db);
  const viewSet = new Set(info.views || []);
  const all = info.tables || [];
  const objs = this.APP.dbObjects?.[db];
  const backups = this.APP.backups?.[db];
  const queries = this.savedQueries(db);
  const match = (name) => !filterLower || String(name).toLowerCase().includes(filterLower);

  const tableRow = (t, isView) => `
    <div class="tbl-row ${this.S.db === db && this.S.table === t ? 'active' : ''} ${isView ? 'is-view' : ''}"
         onclick="window._dbm.selectTable('${jsDb}', '${escJs(t)}')"
         oncontextmenu="window._dbm.onTableContextMenu(event, '${jsDb}', '${escJs(t)}')"
         title="${esc(t)}${isView ? ' (view)' : ''}">
      ${isView ? VIEW_ICON : TABLE_ICON}<span class="tbl-name">${esc(t)}</span>${this.pinButtonHtml(db, t)}
    </div>`;

  const routines = (objs?.routines || []);
  const folders = [
    {
      key: 'tables', label: 'Tables', icon: 'table', add: { title: 'New table', call: `window._dbm.objNewTable('${jsDb}')` },
      count: all.filter(t => !viewSet.has(t)).length,
      items: all.filter(t => !viewSet.has(t) && match(t)).map(t => tableRow(t, false)),
      empty: 'No tables'
    },
    {
      key: 'views', label: 'Views', icon: 'eye-table',
      count: viewSet.size,
      items: all.filter(t => viewSet.has(t) && match(t)).map(t => tableRow(t, true)),
      empty: 'No views'
    },
    {
      key: 'functions', label: 'Functions', icon: 'math-function', lazy: objs,
      count: objs?.loaded ? routines.length : null,
      items: routines.filter(r => match(r.name)).map(r => {
        const isFn = r.type === 'FUNCTION';
        return `
          <div class="tbl-row tree-item" onclick="window._dbm.openDefinition('${jsDb}', '${isFn ? 'function' : 'procedure'}', '${escJs(r.name)}')"
               oncontextmenu="window._dbm.onRoutineContextMenu(event, '${jsDb}', '${escJs(r.type)}', '${escJs(r.name)}')"
               title="${isFn ? 'Function' : 'Procedure'} ${esc(r.name)}${isFn && r.returns ? ` returns ${esc(r.returns)}` : ''}">
            ${ti(isFn ? 'math-function' : 'code-dots')}<span class="tbl-name">${esc(r.name)}</span>
            <span class="tree-meta">${isFn ? 'fn' : 'proc'}</span>
          </div>`;
      }),
      empty: objs?.error || 'No procedures or functions'
    },
    {
      key: 'triggers', label: 'Triggers', icon: 'bolt', lazy: objs, hideWhenEmpty: true,
      count: objs?.loaded ? (objs.triggers || []).length : null,
      items: (objs?.triggers || []).filter(t => match(t.name)).map(t => `
        <div class="tbl-row tree-item" onclick="window._dbm.openDefinition('${jsDb}', 'trigger', '${escJs(t.name)}')"
             oncontextmenu="window._dbm.onTriggerContextMenu(event, '${jsDb}', '${escJs(t.name)}', '${escJs(t.table)}')"
             title="${esc(t.timing)} ${esc(t.event)} on ${esc(t.table)}">
          ${ti('bolt')}<span class="tbl-name">${esc(t.name)}</span>
          <span class="tree-meta">${esc(t.table)}</span>
        </div>`),
      empty: 'No triggers'
    },
    {
      key: 'events', label: 'Events', icon: 'clock', lazy: objs, hideWhenEmpty: true,
      count: objs?.loaded ? (objs.events || []).length : null,
      items: (objs?.events || []).filter(e => match(e.name)).map(e => `
        <div class="tbl-row tree-item" onclick="window._dbm.openDefinition('${jsDb}', 'event', '${escJs(e.name)}')"
             oncontextmenu="window._dbm.onEventContextMenu(event, '${jsDb}', '${escJs(e.name)}')"
             title="Event ${esc(e.name)} (${esc(e.status)})">
          ${ti('clock')}<span class="tbl-name">${esc(e.name)}</span>
          <span class="tree-meta">${esc(String(e.status || '').toLowerCase())}</span>
        </div>`),
      empty: 'No events'
    },
    {
      key: 'queries', label: 'Queries', icon: 'file-code', add: { title: 'New query', call: `window._dbm.newQuery('${jsDb}')` },
      count: queries.length,
      items: queries.filter(q => match(q.name)).map(q => `
        <div class="tbl-row tree-item ${this.S.openQuery?.db === db && this.S.openQuery?.id === q.id && this.S.tab === 'sql' ? 'active' : ''}"
             onclick="window._dbm.openSavedQuery('${jsDb}', '${escJs(q.id)}')"
             oncontextmenu="window._dbm.onQueryContextMenu(event, '${jsDb}', '${escJs(q.id)}')"
             title="${esc(q.name)}">
          ${ti('file-code')}<span class="tbl-name">${esc(q.name)}</span>
        </div>`),
      empty: 'No saved queries. Write SQL in the SQL tab and click Save.'
    },
    {
      key: 'backups', label: 'Backups', icon: 'archive', lazy: backups,
      add: { title: 'Back up this database now', call: `window._dbm.createBackup('${jsDb}')` },
      count: backups?.loaded ? (backups.list || []).length : null,
      items: (backups?.list || []).filter(b => match(b.created)).map(b => `
        <div class="tbl-row tree-item" onclick="window._dbm.onBackupClick(event, '${jsDb}', '${escJs(b.file)}')"
             oncontextmenu="window._dbm.onBackupClick(event, '${jsDb}', '${escJs(b.file)}')"
             title="Backup from ${esc(b.created)} (${esc(formatBytes(b.size))}). Click for restore / download / delete.">
          ${ti('archive')}<span class="tbl-name">${esc(String(b.created).slice(0, 16))}</span>
          <span class="tree-meta">${esc(formatBytes(b.size))}</span>
        </div>`),
      empty: backups?.error || 'No backups yet. Click + to back up this database.'
    }
  ];

  const dbAttr = esc(db);
  let html = `<div class="db-tables-container tree-folders" role="group" data-db="${dbAttr}">`;
  for (const f of folders) {
    const loaded = !f.lazy || f.lazy.loaded;
    if (f.hideWhenEmpty && (!loaded || f.count === 0)) continue;
    // While searching, only show folders with matches, and open them.
    if (filterLower && f.items.length === 0) continue;
    const open = filterLower ? true : this.isFolderOpen(db, f.key);
    const loading = f.lazy && f.lazy.loading;

    html += `
      <div class="tree-folder ${open ? 'open' : ''}" data-db="${dbAttr}" data-folder="${f.key}" role="treeitem" aria-expanded="${open}"
           onclick="window._dbm.toggleFolder('${jsDb}', '${f.key}')"
           oncontextmenu="window._dbm.onFolderContextMenu(event, '${jsDb}', '${f.key}')">
        <span class="tree-arrow">${ti('chevron-right')}</span>
        ${ti(f.icon)}
        <span class="tree-folder-name">${f.label}</span>
        ${f.add ? `<button type="button" class="tree-add" title="${esc(f.add.title)}" aria-label="${esc(f.add.title)}"
                     onclick="event.stopPropagation(); ${f.add.call}">${ti('plus')}</button>` : ''}
        <span class="tree-count">${loading && f.count === null ? '…' : (f.count ?? '')}</span>
      </div>`;
    if (!open) continue;
    html += `<div class="tree-children" data-db="${dbAttr}" data-folder="${f.key}">`;
    if (loading && !loaded) html += '<div class="tbl-empty">Loading…</div>';
    else if (f.items.length) html += f.items.join('');
    else html += `<div class="tbl-empty">${esc(filterLower ? 'No matches' : f.empty)}</div>`;
    html += '</div>';
  }
  return html + '</div>';
}

// ─── FOLDER MENUS ───────────────────────────────────────────

export function onFolderContextMenu(e, db, folder) {
  e.preventDefault();
  e.stopPropagation();
  const items = {
    tables: [
      { label: 'New Table…', action: () => this.objNewTable(db) },
      { label: 'Open Objects', action: () => this.handleDbRowClick(db) },
      '-',
      { label: 'Refresh', action: () => this.refreshDbObjects(db) }
    ],
    views: [{ label: 'Refresh', action: () => this.refreshDbObjects(db) }],
    functions: [{ label: 'Refresh', action: () => this.loadDbObjects(db, true) }],
    triggers: [{ label: 'Refresh', action: () => this.loadDbObjects(db, true) }],
    events: [{ label: 'Refresh', action: () => this.loadDbObjects(db, true) }],
    queries: [{ label: 'New Query', action: () => this.newQuery(db) }],
    backups: [
      { label: 'Back Up Now', action: () => this.createBackup(db) },
      '-',
      { label: 'Refresh', action: () => this.loadBackups(db, true) }
    ]
  }[folder];
  if (items) this.showContextMenu(e.clientX, e.clientY, items);
}

// ─── DEFINITIONS (functions, procedures, triggers, events) ──

/** Load an object's CREATE statement into the SQL tab to read or adapt. */
export async function openDefinition(db, kind, name) {
  try {
    const data = await getJson(this, `${this.apiUrl}?action=show_create&db=${encodeURIComponent(db)}`
      + `&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
    const KIND = kind.toUpperCase();
    this.switchDb(db);
    this.S.openQuery = null;
    this.S.sqlView = false;
    this.S.sqlDraft = `-- ${KIND} \`${name}\` in \`${db}\`\n`
      + `-- To change it: drop it first (right-click it in the sidebar), then run the edited statement below.\n\n`
      + `${data.sql};`;
    this.showTab('sql');
    this.renderSidebar();
  } catch (err) {
    this.showAlertDialog(`Could not open ${kind} ${name}`, err.message, 'error');
  }
}

function insertIntoEditor(app, db, sql) {
  app.switchDb(db);
  app.S.openQuery = null;
  app.S.sqlView = false;
  app.S.sqlDraft = sql;
  app.showTab('sql');
}

function confirmDropObject(app, db, kind, name) {
  app.showConfirmDialog(
    `Drop ${kind.toLowerCase()} "${name}"?`,
    `This permanently removes the ${kind.toLowerCase()} from ${db}.`,
    async () => {
      try {
        await postJson(app, 'drop_object', { db, kind, name });
        app.showMsg(`Dropped ${kind.toLowerCase()} ${name}`);
        app.loadDbObjects(db, true);
      } catch (err) {
        app.showAlertDialog(`Could not drop ${kind.toLowerCase()}`, err.message, 'error');
      }
    },
    { confirmText: 'Drop', type: 'danger' }
  );
}

export function onRoutineContextMenu(e, db, type, name) {
  e.preventDefault();
  e.stopPropagation();
  const isFn = type === 'FUNCTION';
  const kind = isFn ? 'FUNCTION' : 'PROCEDURE';
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'View Definition', action: () => this.openDefinition(db, kind.toLowerCase(), name) },
    { label: isFn ? 'Use in a SELECT' : 'Call Procedure', action: () => insertIntoEditor(this, db, isFn ? `SELECT \`${name}\`();` : `CALL \`${name}\`();`) },
    '-',
    { label: 'Copy Name', action: () => this.copyText(name, 'Name copied') },
    '-',
    { label: isFn ? 'Drop Function…' : 'Drop Procedure…', danger: true, action: () => confirmDropObject(this, db, kind, name) }
  ]);
}

export function onTriggerContextMenu(e, db, name, table) {
  e.preventDefault();
  e.stopPropagation();
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'View Definition', action: () => this.openDefinition(db, 'trigger', name) },
    { label: `Open Table ${table}`, action: () => this.openObjectIn(db, table, 'browse') },
    '-',
    { label: 'Copy Name', action: () => this.copyText(name, 'Name copied') },
    '-',
    { label: 'Drop Trigger…', danger: true, action: () => confirmDropObject(this, db, 'TRIGGER', name) }
  ]);
}

export function onEventContextMenu(e, db, name) {
  e.preventDefault();
  e.stopPropagation();
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'View Definition', action: () => this.openDefinition(db, 'event', name) },
    '-',
    { label: 'Copy Name', action: () => this.copyText(name, 'Name copied') },
    '-',
    { label: 'Drop Event…', danger: true, action: () => confirmDropObject(this, db, 'EVENT', name) }
  ]);
}

// ─── SAVED QUERIES ──────────────────────────────────────────

function connKey(app) {
  return `${app.S.user}@${app.S.host}`;
}

/** Saved queries of a database on the current connection, sorted by name. */
export function savedQueries(db) {
  const all = readJson(QUERIES_KEY, {});
  return [...(all[connKey(this)]?.[db] || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function writeQueries(app, db, list) {
  const all = readJson(QUERIES_KEY, {});
  const key = connKey(app);
  if (!all[key]) all[key] = {};
  all[key][db] = list;
  if (!writeJson(QUERIES_KEY, all)) throw new Error('This browser would not save it (storage full or blocked).');
}

export function newQuery(db) {
  insertIntoEditor(this, db, '');
  this.renderSidebar();
}

export function openSavedQuery(db, id) {
  const q = this.savedQueries(db).find(x => x.id === id);
  if (!q) return;
  this.switchDb(db);
  this.S.openQuery = { db, id };
  this.S.sqlView = false;
  this.S.sqlDraft = q.sql;
  this.showTab('sql');
  this.renderSidebar();
}

/** Save the SQL editor's text. Updates the open saved query unless saveAs. */
export function saveCurrentQuery(saveAs = false) {
  const sql = this.editor ? this.editor.getValue() : (this.S.sqlDraft || '');
  if (!sql.trim()) return this.showMsg('Nothing to save: the editor is empty.', 'error');
  const db = this.S.db;
  if (!db) return this.showMsg('Select a database first; queries are saved per database.', 'error');

  const open = this.S.openQuery;
  const list = this.savedQueries(db);
  const existing = open && open.db === db ? list.find(q => q.id === open.id) : null;

  if (existing && !saveAs) {
    try {
      writeQueries(this, db, list.map(q => (q.id === existing.id ? { ...q, sql, updated: Date.now() } : q)));
      this.showMsg(`Saved query "${existing.name}"`);
      this.renderPanel();
    } catch (err) {
      this.showAlertDialog('Could not save the query', err.message, 'error');
    }
    return;
  }

  const firstLine = sql.trim().split('\n')[0].replace(/^--\s*/, '').slice(0, 40);
  this.showPromptDialog(saveAs ? 'Save Query As' : 'Save Query', {
    message: `Saved in this browser for ${db}. It appears under Queries in the sidebar.`,
    label: 'Query name',
    value: existing ? `${existing.name} copy` : firstLine,
    confirmText: 'Save'
  }, (name) => {
    try {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      writeQueries(this, db, [...list, { id, name, sql, updated: Date.now() }]);
      this.S.openQuery = { db, id };
      this.S.sqlDraft = sql;
      if (!this.isFolderOpen(db, 'queries')) this.toggleFolder(db, 'queries');
      this.showMsg(`Saved query "${name}"`);
      this.renderSidebar();
      this.renderPanel();
    } catch (err) {
      this.showAlertDialog('Could not save the query', err.message, 'error');
    }
  });
}

export function onQueryContextMenu(e, db, id) {
  e.preventDefault();
  e.stopPropagation();
  const q = this.savedQueries(db).find(x => x.id === id);
  if (!q) return;
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'Open Query', action: () => this.openSavedQuery(db, id) },
    { label: 'Rename…', action: () => this.showPromptDialog('Rename Query', { label: 'Query name', value: q.name, confirmText: 'Rename' }, (name) => {
      writeQueries(this, db, this.savedQueries(db).map(x => (x.id === id ? { ...x, name } : x)));
      this.renderSidebar();
      if (this.S.tab === 'sql') this.renderPanel();
    }) },
    { label: 'Copy SQL', action: () => this.copyText(q.sql, 'SQL copied') },
    '-',
    { label: 'Delete Query…', danger: true, action: () => this.showConfirmDialog(
      `Delete query "${q.name}"?`, 'The saved query is removed from this browser.',
      () => {
        writeQueries(this, db, this.savedQueries(db).filter(x => x.id !== id));
        if (this.S.openQuery?.id === id) this.S.openQuery = null;
        this.renderSidebar();
        if (this.S.tab === 'sql') this.renderPanel();
      },
      { confirmText: 'Delete', type: 'danger' }
    ) }
  ]);
}

// ─── BACKUPS ────────────────────────────────────────────────

export async function createBackup(db) {
  this.showMsg(`Backing up ${db}…`);
  try {
    const r = await postJson(this, 'backup_create', { db });
    this.showMsg(`Backed up ${db}: ${r.tables} tables, ${Number(r.rows || 0).toLocaleString()} rows, ${formatBytes(r.size)} (${r.file})`);
    if (!this.isFolderOpen(db, 'backups')) this.toggleFolder(db, 'backups');
    await this.loadBackups(db, true);
  } catch (err) {
    this.showAlertDialog('Backup failed', err.message, 'error');
  }
}

/** A backup's actions, shown as a menu on click or right-click. */
export function onBackupClick(e, db, file) {
  e.preventDefault();
  e.stopPropagation();
  const b = (this.APP.backups?.[db]?.list || []).find(x => x.file === file);
  const when = b ? b.created : file;
  this.showContextMenu(e.clientX, e.clientY, [
    { label: 'Restore This Backup…', action: () => this.restoreBackup(db, file, when) },
    { label: 'Download .sql', action: () => this.downloadBackup(db, file) },
    '-',
    { label: 'Delete Backup…', danger: true, action: () => this.showConfirmDialog(
      `Delete the backup from ${when}?`, 'The backup file is permanently deleted from the server.',
      async () => {
        try {
          await postJson(this, 'backup_delete', { db, file });
          this.showMsg(`Deleted backup ${file}`);
          this.loadBackups(db, true);
        } catch (err) {
          this.showAlertDialog('Could not delete the backup', err.message, 'error');
        }
      },
      { confirmText: 'Delete', type: 'danger' }
    ) }
  ]);
}

export function restoreBackup(db, file, when) {
  this.showConfirmDialog(
    `Restore ${db} to ${when}?`,
    `Every table in this backup is dropped and recreated with the data it had at ${when}. ` +
    `Changes made since then to those tables are lost. Tables created after the backup are left alone.\n\n` +
    `Tip: back up the current state first if you might want it back.`,
    async () => {
      this.showMsg(`Restoring ${db} from ${file}…`);
      try {
        const r = await postJson(this, 'backup_restore', { db, file });
        if (r.success) {
          this.showMsg(`Restored ${db} from ${when}: ${r.queries_executed} statements in ${r.time_ms} ms`);
        } else {
          const first = (r.errors || [])[0];
          this.showAlertDialog('Restore stopped with an error',
            `${r.queries_executed} of ${r.queries_total} statements ran before it failed.\n\n` +
            (first ? `Statement #${first.query_index}: ${first.error}\n\n${first.snippet}` : ''), 'error');
        }
        this.APP.dbObjects && delete this.APP.dbObjects[db];
        await this.refreshDbObjects(db);
        if (this.S.db === db && this.S.table) this.loadTableDataFromServer(db, this.S.table);
      } catch (err) {
        this.showAlertDialog('Restore failed', err.message, 'error');
      }
    },
    { confirmText: 'Restore', type: 'danger' }
  );
}

export function downloadBackup(db, file) {
  const a = document.createElement('a');
  a.href = `${this.apiUrl}?action=backup_download&db=${encodeURIComponent(db)}&file=${encodeURIComponent(file)}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
