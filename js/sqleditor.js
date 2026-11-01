// The SQL tab. A CodeMirror editor that runs the selection or the statement at
// the cursor (Ctrl+Enter) or every statement (Ctrl+Shift+Enter), with one result
// tab per statement and errors shown in place, plus timing, per-result paging,
// export of all rows, a database picker, autocomplete for every table and column
// in the database, query history, and a resizable editor.
//
// The editor is built once and kept across runs (results re-render on their
// own), so the cursor, selection and undo history survive running a query.

import { esc, escJs, ti } from './util.js';
import { exportData } from './export.js';
import { columnInputSpec } from './cellinput.js';

const HISTORY_KEY = 'dbm_sql_history';
const HEIGHT_KEY = 'dbm_sql_h';
const MAX_HISTORY = 100;
const EXPORT_CAP = 100000;

// ─── HELPERS ────────────────────────────────────────────────

/** Split SQL into statements on ";" (outside quotes and comments), with offsets. */
function splitStatements(text) {
  const out = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  let quote = null;
  const push = (a, b) => {
    const raw = text.slice(a, b);
    const code = raw.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*/g, '').trim();
    if (code) out.push({ sql: raw.trim(), start: a, end: b });
  };
  while (i < n) {
    const ch = text[i];
    const nx = text[i + 1];
    if (quote) {
      if (ch === '\\' && quote !== '`') { i += 2; continue; }
      if (ch === quote) {
        if (nx === quote) { i += 2; continue; }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue; }
    if ((ch === '-' && nx === '-' && (i + 2 >= n || /\s/.test(text[i + 2]))) || ch === '#') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === '/' && nx === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (ch === ';') { push(start, i); start = i + 1; }
    i++;
  }
  push(start, n);
  return out;
}

/** The statement the cursor is in (or just after). */
function statementAt(stmts, index) {
  let pick = null;
  for (const s of stmts) {
    if (s.start <= index) pick = s;
    if (index <= s.end) break;
  }
  return pick || stmts[0] || null;
}

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*/g, ' ');
const verbOf = (sql) => (stripComments(sql).trim().match(/^\(?\s*([a-z]+)/i)?.[1] || '').toUpperCase();

/** Statements that can destroy data without a second look. */
function riskOf(sql) {
  const s = stripComments(sql);
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW)\b/i.test(s)) return 'deletes a table or database for good';
  if (/\bTRUNCATE\b/i.test(s)) return 'deletes every row of a table';
  // "WHERE 1" (from the UPDATE template) matches every row, same as no WHERE.
  const everyRow = !/\bWHERE\b/i.test(s) || /\bWHERE\s+(1|TRUE|1\s*=\s*1)\s*;?\s*$/i.test(s.trim());
  if (/^\s*DELETE\b/i.test(s) && everyRow) return 'has no real WHERE, so it deletes every row';
  if (/^\s*UPDATE\b/i.test(s) && everyRow) return 'has no real WHERE, so it changes every row';
  return '';
}

// ─── FORMAT ─────────────────────────────────────────────────

const FMT_TOKEN = /[nNbBxX]'(?:''|[^'])*'|'(?:\\[\s\S]|''|[^'\\])*'|"(?:\\[\s\S]|""|[^"\\])*"|`(?:``|[^`])*`|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|@@?[\w.$]+|:\w+|\w+|\s+|<=>|>=|<=|<>|!=|:=|\|\||&&|[\s\S]/g;
const FMT_KEYWORDS = new Set(('select from where and or not in is null like between as on using join left right inner outer cross full natural ' +
  'group by order having limit offset insert into values value update set delete union all distinct case when then else end asc desc ' +
  'exists with interval true false replace ignore duplicate key regexp div mod xor').split(' '));
const FMT_FUNCS = new Set(('count sum avg min max if ifnull coalesce concat concat_ws substring substr trim lower upper length round floor ceil ' +
  'now date date_format year month day cast convert group_concat nullif datediff date_add date_sub abs').split(' '));
const FMT_CLAUSE = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'SET', 'VALUES', 'UNION', 'UPDATE', 'INSERT', 'DELETE', 'REPLACE']);
const FMT_JOIN = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL', 'JOIN', 'STRAIGHT_JOIN']);

/**
 * Tidy SQL: keywords in capitals, each clause on its own line, SELECT columns,
 * JOINs and AND/OR conditions indented. Strings, names and comments are left as they are.
 */
export function formatSql(sql) {
  const toks = (sql.match(FMT_TOKEN) || []).filter(t => !/^\s+$/.test(t));
  let out = '';
  let prevClause = false; // previous token started a clause (VALUES (…) vs VALUES(col))
  let depth = 0;
  let clause = '';
  let prev = '';        // previous significant token (upper-cased when a keyword)
  let prevKw = false;
  let glue = false;     // no space before the next token (after "." or a unary minus)
  let inBetween = false;
  const nl = (indent = '') => {
    out = out.replace(/[ \t]+$/, '');
    if (out && !out.endsWith('\n')) out += '\n';
    out += indent;
  };
  const put = (s, spaceBefore = true) => {
    if (out && spaceBefore && !glue && !/[\s(]$/.test(out)) out += ' ';
    out += s;
    glue = false;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--') || t.startsWith('#')) { put(t); out += '\n'; continue; }
    const isWord = /^\w+$/.test(t);
    const up = t.toUpperCase();
    // Function names in capitals only when called: COUNT(…), not a column named "date".
    if (isWord && prev !== '.' && toks[i + 1] === '(' && FMT_FUNCS.has(t.toLowerCase())) {
      put(up); prev = up; prevKw = false; prevClause = false;
      continue;
    }
    const kw = isWord && prev !== '.' && FMT_KEYWORDS.has(t.toLowerCase());
    if (kw) {
      prevClause = false;
      const startsClause = depth === 0 && FMT_CLAUSE.has(up)
        && !(up === 'SET' && prev === 'CHARACTER') && !(up === 'UPDATE' && prev === 'KEY')
        && !(up === 'VALUES' && clause !== 'INSERT' && clause !== 'REPLACE');
      if (startsClause) {
        nl(); put(up); clause = up; prevClause = true;
      } else if (depth === 0 && FMT_JOIN.has(up) && !FMT_JOIN.has(prev)) {
        nl('  '); put(up);
      } else if (depth === 0 && (up === 'AND' || up === 'OR') && (clause === 'WHERE' || clause === 'HAVING') && !(up === 'AND' && inBetween)) {
        nl('  '); put(up);
      } else {
        put(up);
      }
      if (up === 'BETWEEN') inBetween = true;
      else if (up === 'AND') inBetween = false;
      prev = up; prevKw = true;
      continue;
    }
    if (t === '(') {
      const tight = /^\w+$/.test(prev) && (!prevKw || (prev === 'VALUES' && !prevClause));
      put('(', !tight);
      depth++;
    } else if (t === ')') {
      depth = Math.max(0, depth - 1);
      put(')', false);
    } else if (t === ',') {
      put(',', false);
      if (depth === 0 && clause === 'SELECT') nl('  ');
    } else if (t === ';') {
      put(';', false);
      out += '\n\n';
      depth = 0; clause = '';
    } else if (t === '.') {
      put('.', false);
      glue = true;
    } else {
      const unary = t === '-' && (prevKw || /^(\(|,|=|<|>|<=|>=|<>|!=|\+|-|\*|\/)$/.test(prev) || !prev);
      put(t);
      if (unary) glue = true;
    }
    prev = t; prevKw = false; prevClause = false;
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

function connKey(app) {
  return `${app.S.user}@${app.S.host}`;
}

function readHistory(app) {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}')[connKey(app)] || [];
  } catch (e) {
    return [];
  }
}

function pushHistory(app, entry) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    const list = (all[connKey(app)] || []).filter(h => !(h.sql === entry.sql && h.db === entry.db));
    all[connKey(app)] = [entry, ...list].slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch (e) { /* history is a convenience; ignore storage errors */ }
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const fmtMs = (ms) => (ms === null || ms === undefined ? '' : ms < 1000 ? `${Math.round(ms * 10) / 10} ms` : `${(ms / 1000).toFixed(2)} s`);

function editorAlive(app) {
  const p = document.getElementById('panel');
  return !!(app.editor && p && p.contains(app.editor.getWrapperElement()));
}

/** Run one statement on the server. Never throws for SQL errors: they become a result. */
async function execStatement(app, sql, page = 1) {
  const perPage = parseInt(app.S.perPage, 10) || 25;
  const t0 = performance.now();
  let res;
  let data = {};
  try {
    res = await fetch(`${app.apiUrl}?action=run_query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: app.S.db, query: sql, page, per_page: perPage })
    });
    if (res.status === 401) {
      app.handleSessionExpired();
      return { ok: false, kind: 'error', sql, error: 'Your session has expired. Log in again.' };
    }
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return { ok: false, kind: 'error', sql, error: `Could not reach the server: ${err.message}`, time_ms: performance.now() - t0 };
  }
  if (!res.ok || data.success === false) {
    return { ok: false, kind: 'error', sql, error: data.error || `Request failed (${res.status})`, time_ms: performance.now() - t0 };
  }
  const hasRows = (data.headers || []).length > 0;
  return {
    ok: true, kind: hasRows ? 'rows' : 'message', sql,
    headers: data.headers || [], data: data.data || [], total: data.totalRows || 0,
    page, perPage, paginated: !!data.paginated, verb: data.verb || verbOf(sql),
    affected: data.affected, insertId: data.insert_id, time_ms: data.time_ms ?? (performance.now() - t0)
  };
}

// ─── RUNNING ────────────────────────────────────────────────

/**
 * Run SQL from the editor. mode "smart" (Ctrl+Enter): the selection, or the
 * statement at the cursor. mode "all" (Ctrl+Shift+Enter): every statement.
 * mode "explain": EXPLAIN the statement at the cursor.
 */
export async function runQuery(mode = 'smart') {
  if (typeof mode !== 'string') mode = 'smart';
  if (this.S.sqlRunning) return;
  const text = this.editor ? this.editor.getValue() : (this.S.sqlDraft || '');
  const selection = this.editor && this.editor.somethingSelected() ? this.editor.getSelection() : '';
  let stmts;
  if (mode === 'all') stmts = splitStatements(text);
  else if (selection.trim()) stmts = splitStatements(selection);
  else {
    const all = splitStatements(text);
    const at = statementAt(all, this.editor ? this.editor.indexFromPos(this.editor.getCursor()) : 0);
    stmts = at ? [at] : [];
  }
  let sqls = stmts.map(s => s.sql.replace(/;\s*$/, ''));
  if (!sqls.length) {
    this.S.sqlResults = [{ ok: false, kind: 'error', sql: '', error: 'Nothing to run: write a query first.' }];
    this.S.sqlActive = 0;
    return this.renderSqlResults();
  }
  if (mode === 'explain') {
    if (!/^(SELECT|WITH|UPDATE|DELETE|INSERT|REPLACE|TABLE)$/.test(verbOf(sqls[0]))) {
      return this.alertDialog({ type: 'info', title: 'Nothing to explain', message: 'EXPLAIN works on SELECT, UPDATE, DELETE and INSERT statements.' });
    }
    sqls = [`EXPLAIN ${sqls[0]}`];
  }
  return this.runSqlList(sqls);
}

/** Run a list of statements (asks first for destructive ones) and show the results. */
export async function runSqlList(sqls) {
  if (this.S.sqlRunning || !sqls.length) return;
  const risky = sqls.map(s => ({ sql: s, why: riskOf(s) })).filter(r => r.why);
  if (risky.length) {
    const ok = await this.confirmDialog({
      type: 'danger',
      title: risky.length === 1 ? 'Run a destructive statement?' : `${risky.length} statements can destroy data`,
      message: risky.length === 1 ? `This statement ${risky[0].why}. It can't be undone.` : 'Each of these can permanently delete or change data:',
      details: risky.map(r => r.sql.length > 220 ? r.sql.slice(0, 219) + '…' : r.sql).join('\n\n'),
      confirmText: 'Run anyway'
    });
    if (!ok) return;
  }

  this.S.sqlRunning = true;
  this.S.sqlResults = [];
  this.S.sqlActive = 0;
  this.S.currentQuery = sqls.join(';\n');
  this.S.sqlLastRun = sqls.slice();
  // Like phpMyAdmin: fold the editor into a small summary of what ran,
  // unless "Keep the editor open" is ticked.
  if (!sqlKeepOpen()) this.S.sqlView = true;
  this.applySqlMode();
  this.renderSqlResults();
  this.renderSqlToolbar();

  let changedSchema = false;
  for (const sql of sqls) {
    const r = await execStatement(this, sql);
    this.S.sqlResults.push(r);
    this.S.sqlActive = this.S.sqlResults.length - 1;
    this.renderSqlResults();
    if (!r.ok) break;
    if (/^(CREATE|DROP|ALTER|RENAME|TRUNCATE)$/.test(r.verb)) changedSchema = true;
    // USE only lasts for that request on the server; switch the app's database instead.
    if (r.verb === 'USE') {
      const target = stripComments(sql).trim().replace(/^USE\s+/i, '').replace(/^`|`$/g, '').replace(/``/g, '`');
      if (this.APP.databases[target]) this.sqlSetDb(target);
    }
  }
  this.S.sqlRunning = false;

  // Show the first error if there is one, else the last result with rows.
  const results = this.S.sqlResults;
  const errAt = results.findIndex(r => !r.ok);
  const rowsAt = results.map(r => r.kind).lastIndexOf('rows');
  this.S.sqlActive = errAt >= 0 ? errAt : (rowsAt >= 0 ? rowsAt : results.length - 1);

  pushHistory(this, {
    sql: sqls.length > 1 ? sqls.join(';\n\n') + ';' : sqls[0],
    db: this.S.db,
    at: Date.now(),
    ok: errAt < 0,
    ms: results.reduce((s, r) => s + (r.time_ms || 0), 0),
    rows: results.reduce((s, r) => s + (r.kind === 'rows' ? r.total : (r.affected || 0)), 0)
  });

  const failed = results.filter(r => !r.ok).length;
  if (failed) this.showMsg(results[errAt].error, 'error');
  else this.showMsg(results.length === 1 ? describeResult(results[0]) : `Ran ${results.length} statements`);

  if (changedSchema) {
    if (this.APP.dbColumns) delete this.APP.dbColumns[this.S.db];
    this.APP.sqlEditMeta = {};
    this.loadDatabasesFromServer();
  }
  this.renderSqlResults();
  this.renderSqlToolbar();
  this.renderSqlSummary();
  if (this.editor && !this.S.sqlView) this.editor.focus();
}

// ─── EDIT / SUMMARY MODE ────────────────────────────────────

const KEEP_KEY = 'dbm_sql_keep_open';
function sqlKeepOpen() {
  try { return localStorage.getItem(KEEP_KEY) === '1'; } catch (e) { return false; }
}
export function setSqlKeepOpen(on) {
  try { localStorage.setItem(KEEP_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

/** Show either the full editor or the folded summary. */
export function applySqlMode() {
  const edit = document.getElementById('sqlx-edit');
  const sum = document.getElementById('sqlx-summary');
  if (!edit || !sum) return;
  const view = !!this.S.sqlView;
  edit.hidden = view;
  sum.hidden = !view;
  if (view) this.renderSqlSummary();
  else if (this.editor) this.editor.refresh();
}

/** "Edit": open the editor again with the query that ran. */
export function sqlEdit() {
  this.S.sqlView = false;
  this.applySqlMode();
  if (this.editor) this.editor.focus();
}

/** "Refresh": run the same statements again. */
export function sqlRefresh() {
  if (this.S.sqlLastRun?.length) this.runSqlList(this.S.sqlLastRun);
}

/** "Explain": EXPLAIN the first statement that ran. */
export function sqlExplainLast() {
  const first = (this.S.sqlLastRun || [])[0];
  if (!first) return;
  const base = first.replace(/^\s*EXPLAIN\s+/i, '');
  if (!/^(SELECT|WITH|UPDATE|DELETE|INSERT|REPLACE|TABLE)$/.test(verbOf(base))) {
    return this.alertDialog({ type: 'info', title: 'Nothing to explain', message: 'EXPLAIN works on SELECT, UPDATE, DELETE and INSERT statements.' });
  }
  this.runSqlList([`EXPLAIN ${base}`]);
}

export async function sqlCopyLast() {
  const text = (this.S.sqlLastRun || []).join(';\n') + ';';
  try {
    await navigator.clipboard.writeText(text);
    this.showMsg('Query copied');
  } catch (e) {
    this.showMsg('Could not copy: the browser blocked the clipboard.', 'error');
  }
}

/** Colour SQL like the editor does (CodeMirror runmode), or plain text without it. */
function highlightSql(el, sql) {
  if (typeof CodeMirror !== 'undefined' && CodeMirror.runMode) CodeMirror.runMode(sql, 'text/x-mysql', el);
  else el.textContent = sql;
}

export function renderSqlSummary() {
  const box = document.getElementById('sqlx-summary');
  if (!box || !this.S.sqlView) return;
  const sqls = this.S.sqlLastRun || [];
  const results = this.S.sqlResults || [];
  const running = !!this.S.sqlRunning;
  const failed = results.find(r => !r.ok);
  const total = results.reduce((s, r) => s + (r.time_ms || 0), 0);

  let cls = 'ok';
  let msg;
  if (running) { cls = 'run'; msg = `<span class="spinner"></span> Running ${sqls.length > 1 ? `${sqls.length} statements` : 'the query'}…`; }
  else if (failed) { cls = 'err'; msg = `${ti('alert-triangle')} ${sqls.length > 1 ? `Statement ${results.indexOf(failed) + 1} of ${sqls.length} failed` : 'The query failed'}. See the error below.`; }
  else if (results.length === 1 && results[0].kind === 'rows') {
    const r = results[0];
    const from = r.total ? (r.page - 1) * r.perPage + 1 : 0;
    const to = r.paginated ? Math.min(r.page * r.perPage, r.total) : r.data.length;
    msg = `${ti('circle-check')} ${r.total ? `Showing rows ${from.toLocaleString()} – ${to.toLocaleString()} (${Number(r.total).toLocaleString()} total` : 'No rows (0 total'}, query took ${fmtMs(r.time_ms)})`;
  } else if (results.length === 1) msg = `${ti('circle-check')} ${esc(describeResult(results[0]))}`;
  else msg = `${ti('circle-check')} Ran ${results.length} statements in ${fmtMs(total)}`;

  box.innerHTML = `
    <div class="sqlx-sum-msg ${cls}" role="status">${msg}</div>
    <pre class="sqlx-sum-sql cm-s-${this.S.theme === 'dark' ? 'dracula' : 'default'}" ondblclick="window._dbm.sqlEdit()" title="Double-click to edit"></pre>
    <div class="sqlx-sum-actions">
      <button type="button" class="btn btn-sm primary" onclick="window._dbm.sqlEdit()" title="Open the editor with this query">${ti('pencil')} Edit</button>
      <button type="button" class="btn btn-sm" onclick="window._dbm.sqlExplainLast()" ${running ? 'disabled' : ''} title="Show how MySQL runs this query">${ti('route')} Explain</button>
      <button type="button" class="btn btn-sm" onclick="window._dbm.sqlRefresh()" ${running ? 'disabled' : ''} title="Run it again">${ti('refresh')} Refresh</button>
      <button type="button" class="btn btn-sm" onclick="window._dbm.sqlCopyLast()" title="Copy the SQL">${ti('copy')} Copy</button>
      <button type="button" class="btn btn-sm" onclick="window._dbm.saveCurrentQuery(false)" title="Save as a named query in the sidebar">${ti('device-floppy')} Save query</button>
      <span class="sqlx-sum-db" title="Database">${ti('database')} ${esc(this.S.db || '')}</span>
    </div>`;
  highlightSql(box.querySelector('.sqlx-sum-sql'), sqls.join(';\n') + (sqls.length ? ';' : ''));
}

// ─── EDITING RESULTS ────────────────────────────────────────
// A result can be edited in place when it is a plain SELECT from one table whose
// primary key is among the columns shown (like Navicat / phpMyAdmin). Anything
// else (joins, GROUP BY, calculated or renamed columns) stays read-only, with the
// reason shown above the grid.

const IDENT = '(?:`(?:``|[^`])+`|[A-Za-z_$][\\w$]*)';
const unq = (s) => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s);
const SIMPLE_SELECT = new RegExp(
  `^SELECT\\s+([\\s\\S]+?)\\s+FROM\\s+(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?` +
  `(?:\\s+(?:AS\\s+)?(?!(?:WHERE|ORDER|LIMIT)\\b)${IDENT})?` +
  `\\s*(?:(?:WHERE|ORDER\\s+BY|LIMIT)\\b[\\s\\S]*)?$`, 'i');
const PLAIN_ITEM = new RegExp(`^(?:${IDENT}\\s*\\.\\s*)?(?:\\*|${IDENT})$`);

/** The table a SELECT reads from, or { why } when it can't be edited. null for non-SELECTs. */
function editSource(sql, defaultDb) {
  const s = stripComments(sql).trim().replace(/;\s*$/, '');
  if (!/^SELECT\b/i.test(s)) return null;
  if (/\b(JOIN|UNION|GROUP\s+BY|HAVING|DISTINCT|INTO|WITH\s+ROLLUP)\b/i.test(s)) return { why: 'it joins, groups or combines rows' };
  const m = s.match(SIMPLE_SELECT);
  if (!m) return { why: 'it does not read from a single table' };
  const items = m[1].split(',').map(x => x.trim());
  if (/\(/.test(m[1]) || !items.every(x => PLAIN_ITEM.test(x))) return { why: 'it shows calculated or renamed columns' };
  return { db: m[3] ? unq(m[2]) : defaultDb, table: unq(m[3] || m[2]) };
}

/** Columns and primary key of a table, loaded once (then the results re-render). */
export async function loadSqlEditMeta(db, table) {
  const key = `${db}\u0000${table}`;
  if (!this.APP.sqlEditMeta) this.APP.sqlEditMeta = {};
  if (this.APP.sqlEditMeta[key]) return;
  this.APP.sqlEditMeta[key] = { loading: true };
  let meta;
  try {
    const res = await fetch(`${this.apiUrl}?action=table_columns&db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    const cols = (data.columns || []).map(c => ({ n: c.name, t: c.type, x: c.key === 'PRI' ? 'PK' : '', null: !!c.null }));
    meta = { cols, pk: cols.filter(c => c.x === 'PK').map(c => c.n) };
  } catch (err) {
    meta = { error: err.message };
  }
  this.APP.sqlEditMeta[key] = meta;
  this.renderSqlResults();
}

/** How (and whether) the rows of result r can be edited. */
function editInfo(app, r) {
  if (!r || !r.ok || r.kind !== 'rows') return null;
  const src = editSource(r.sql, app.S.db);
  if (!src) return null;
  if (src.why) return { why: src.why };
  const meta = app.APP.sqlEditMeta?.[`${src.db}\u0000${src.table}`];
  if (!meta) { app.loadSqlEditMeta(src.db, src.table); return { loading: true }; }
  if (meta.loading) return { loading: true };
  if (meta.error) return { why: `could not read the columns of ${src.table}` };
  const byName = Object.fromEntries(meta.cols.map(c => [c.n, c]));
  if (new Set(r.headers).size !== r.headers.length) return { why: 'a column appears twice' };
  if (!r.headers.every(h => byName[h])) return { why: `some columns are not columns of ${src.table}` };
  if (!meta.pk.length) return { why: `${src.table} has no primary key` };
  const pkIdx = meta.pk.map(p => r.headers.indexOf(p));
  if (pkIdx.some(i => i < 0)) return { why: `add the primary key (${meta.pk.join(', ')}) to the columns to edit` };
  return { db: src.db, table: src.table, cols: r.headers.map(h => byName[h]), pk: meta.pk, pkIdx };
}

const rowValues = (r, ri) => (Array.isArray(r.data[ri]) ? r.data[ri] : r.headers.map(h => r.data[ri][h]));
function setRowValue(r, ri, ci, v) {
  if (Array.isArray(r.data[ri])) r.data[ri][ci] = v;
  else r.data[ri][r.headers[ci]] = v;
}
const enumOptions = (type) => {
  const m = String(type).match(/^(?:enum|set)\((.*)\)$/i);
  if (!m || /^set/i.test(type)) return null;
  const out = [];
  const re = /'((?:''|[^'])*)'/g;
  let x;
  while ((x = re.exec(m[1])) !== null) out.push(x[1].replace(/''/g, "'"));
  return out;
};

/** Double-click on a result cell: edit it in place and save with UPDATE … WHERE <primary key>. */
export function sqlEditCell(td) {
  if (td.classList.contains('cell-editing') || this.S.sqlRunning) return;
  const r = (this.S.sqlResults || [])[this.S.sqlActive];
  const ed = editInfo(this, r);
  if (!ed || !ed.cols) return;
  const ri = Number(td.dataset.r);
  const ci = Number(td.dataset.c);
  const col = ed.cols[ci];
  if (!col || ed.pk.includes(col.n)) return;
  const row = rowValues(r, ri);
  const current = row[ci];
  const pk = {};
  ed.pk.forEach((p, k) => { pk[p] = row[ed.pkIdx[k]]; });

  const opts = enumOptions(col.t);
  const spec = opts ? null : columnInputSpec(col);
  let initial = current === null || current === undefined ? '' : String(current);
  const typed = spec && (current === null || current === undefined || spec.toInput(current) !== undefined);
  if (typed && current !== null && current !== undefined) initial = spec.toInput(current);
  const long = !opts && !typed && (initial.length > 60 || initial.includes('\n'));

  td.classList.add('cell-editing');
  const attrs = typed ? Object.entries(spec.attrs || {}).map(([k, v]) => `${k}="${esc(v)}"`).join(' ') : '';
  td.innerHTML = `
    <div class="cell-editor">
      ${opts ? `<select class="cell-input" aria-label="${esc(col.n)}">
          ${col.null ? `<option value="__null__" ${current === null ? 'selected' : ''}>NULL</option>` : ''}
          ${opts.map(o => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>`
      : long ? `<textarea class="cell-input sqlx-cell-text" rows="3" aria-label="${esc(col.n)}" spellcheck="false">${esc(initial)}</textarea>`
      : `<input class="cell-input ${typed ? `cell-input-${spec.kind}` : ''}" type="${typed ? spec.type : 'text'}" ${attrs} value="${esc(initial)}" aria-label="${esc(col.n)}" spellcheck="false">`}
      ${col.null && !opts ? '<button type="button" class="cell-null-btn" tabindex="-1" title="Set to NULL">NULL</button>' : ''}
    </div>`;
  const input = td.querySelector('.cell-input');
  const nullBtn = td.querySelector('.cell-null-btn');
  const hint = document.createElement('div');
  hint.className = 'cell-hint';
  hint.setAttribute('role', 'status');
  if (typed) document.body.appendChild(hint);

  let finished = false;
  const check = () => {
    if (!typed) return { ok: true, value: input.value };
    const res = spec.parse(input.value);
    let error = res.ok ? '' : res.error;
    if (!error && input.validity?.badInput) error = 'Finish entering the value.';
    if (!error && res.value === '' && !col.null) error = `${col.n} is NOT NULL, so it needs a value.`;
    input.classList.toggle('invalid', !!error);
    hint.textContent = error || spec.hint;
    hint.classList.toggle('error', !!error);
    const b = input.getBoundingClientRect();
    hint.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - hint.offsetWidth - 8))}px`;
    hint.style.top = `${b.bottom + 4}px`;
    return error ? null : res;
  };
  const end = () => { finished = true; hint.remove(); };
  const cancel = () => { end(); this.renderSqlResults(); };
  const save = async (value) => {
    end();
    // An empty value in a nullable column is stored as NULL (same as Browse).
    if (value === '' && col.null && !opts) value = null;
    const before = current === undefined ? null : current;
    if (value === before || (value !== null && before !== null && String(value) === String(before))) return this.renderSqlResults();
    td.classList.add('sqlx-saving');
    try {
      const res = await fetch(`${this.apiUrl}?action=update_cell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db: ed.db, table: ed.table, column: col.n, value, pk })
      });
      if (res.status === 401) return this.handleSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
      setRowValue(r, ri, ci, value);
      if (ed.db === this.S.db && this.APP.tableData) delete this.APP.tableData[ed.table]; // Browse reloads it
      this.S.sqlFlash = `${ri}:${ci}`;
      this.showMsg(data.affected === 0 ? `${col.n}: no row changed (it may have been deleted)` : `Updated ${ed.table}.${col.n}`, data.affected === 0 ? 'error' : undefined);
    } catch (err) {
      this.showMsg(`${col.n} not saved: ${err.message}`, 'error');
    }
    this.renderSqlResults();
    this.S.sqlFlash = null;
  };

  input.addEventListener('input', check);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter' && !(long && e.shiftKey)) {
      e.preventDefault();
      const res = check();
      if (res) save(opts && input.value === '__null__' ? null : res.value);
    }
  });
  if (opts) input.addEventListener('change', () => { if (!finished) save(input.value === '__null__' ? null : input.value); });
  input.addEventListener('blur', () => {
    if (finished) return;
    const res = check();
    if (res) save(opts && input.value === '__null__' ? null : res.value);
    else { this.showMsg(`${col.n} not saved: ${hint.textContent}`, 'error'); cancel(); }
  });
  if (nullBtn) {
    nullBtn.addEventListener('mousedown', (e) => e.preventDefault());
    nullBtn.addEventListener('click', () => { if (!finished) save(null); });
  }
  input.focus();
  if (input.select && !opts) input.select();
  if (typed) {
    check();
    if (spec.picker && typeof input.showPicker === 'function') { try { input.showPicker(); } catch (e) { /* typing still works */ } }
  }
}

// ─── TEMPLATES / COLUMN LIST ────────────────────────────────

const q = (n) => '`' + String(n).replace(/`/g, '``') + '`';

/** Table the templates and the column list use: the open table, else the first one. */
function sideTable(app) {
  const tables = app.APP.databases[app.S.db]?.tables || [];
  if (app.S.sqlTable && tables.includes(app.S.sqlTable)) return app.S.sqlTable;
  if (app.S.table && tables.includes(app.S.table)) return app.S.table;
  return tables[0] || '';
}
function sideColumns(app, t) {
  return app.APP.dbColumns?.[app.S.db]?.[t] || app.APP.colHeaders?.[t] || null;
}

export function sqlSetSideTable(t) {
  this.S.sqlTable = t;
  this.renderSqlSide();
}

/** Right-hand list: the columns of the chosen table. Click one to insert it. */
export function renderSqlSide() {
  const box = document.getElementById('sqlx-cols');
  if (!box) return;
  const tables = this.APP.databases[this.S.db]?.tables || [];
  const t = sideTable(this);
  const cols = t ? sideColumns(this, t) : [];
  box.innerHTML = `
    <select class="sqlx-cols-table" aria-label="Table for the column list and the buttons below" onchange="window._dbm.sqlSetSideTable(this.value)">
      ${tables.map(n => `<option value="${esc(n)}" ${n === t ? 'selected' : ''}>${esc(n)}</option>`).join('')}
    </select>
    <div class="sqlx-cols-list" role="list" aria-label="Columns">
      ${!t ? '<div class="sqlx-cols-empty">No tables.</div>'
        : !cols ? '<div class="sqlx-cols-empty">Loading…</div>'
        : `<button type="button" class="sqlx-col sqlx-col-table" title="Insert the table name" onclick="window._dbm.sqlInsertName('${escJs(t)}')">${ti('table')}${esc(t)}</button>` +
          cols.map(c => `<button type="button" class="sqlx-col" role="listitem" title="Insert ${esc(c)}" onclick="window._dbm.sqlInsertName('${escJs(c)}')">${esc(c)}</button>`).join('')}
    </div>
    <div class="sqlx-cols-hint">Click a name to insert it</div>`;
  this.renderSqlTemplates();
}

export function sqlInsertName(name) {
  if (!this.editor) return;
  this.editor.replaceSelection(q(name));
  this.editor.focus();
}

/** Buttons under the editor: query templates for the chosen table, Clear, Format. */
export function renderSqlTemplates() {
  const box = document.getElementById('sqlx-templates');
  if (!box) return;
  const t = sideTable(this);
  const dis = t ? '' : 'disabled';
  box.innerHTML = `
    <div class="sqlx-btn-group" role="group" aria-label="Query templates${t ? ` for ${esc(t)}` : ''}">
      ${['SELECT *', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].map(k =>
        `<button type="button" class="btn btn-sm" ${dis} onclick="window._dbm.sqlTemplate('${k}')" title="${k} template for ${esc(t)}">${k}</button>`).join('')}
    </div>
    <div class="sqlx-btn-group" role="group">
      <button type="button" class="btn btn-sm" onclick="window._dbm.sqlClearEditor()" title="Clear the editor">${ti('eraser')} Clear</button>
      <button type="button" class="btn btn-sm" onclick="window._dbm.sqlFormat()" title="Tidy up the SQL (the selection, or everything)">${ti('align-left')} Format</button>
    </div>
    <label class="sqlx-keep" title="Like phpMyAdmin's “Retain query box”">
      <input type="checkbox" ${sqlKeepOpen() ? 'checked' : ''} onchange="window._dbm.setSqlKeepOpen(this.checked)"> Keep the editor open after running
    </label>`;
}

export function sqlTemplate(kind) {
  const t = sideTable(this);
  if (!t || !this.editor) return;
  const cols = sideColumns(this, t) || [];
  const list = cols.length ? cols.map(q).join(', ') : '*';
  const vals = cols.map((c, i) => `'[value-${i + 1}]'`).join(', ');
  const sql = {
    'SELECT *': `SELECT * FROM ${q(t)} WHERE 1;`,
    'SELECT': `SELECT ${list} FROM ${q(t)} WHERE 1;`,
    'INSERT': `INSERT INTO ${q(t)}(${list}) VALUES (${vals});`,
    'UPDATE': `UPDATE ${q(t)} SET ${cols.map((c, i) => `${q(c)}='[value-${i + 1}]'`).join(', ')} WHERE 1;`,
    'DELETE': `DELETE FROM ${q(t)} WHERE 0;`
  }[kind];
  if (!sql) return;
  this.editor.setValue(sql);
  this.S.openQuery = null;
  this.renderSqlToolbar();
  this.editor.focus();
  // Put the cursor where it is usually changed: after WHERE.
  const at = sql.lastIndexOf('WHERE ');
  this.editor.setCursor(this.editor.posFromIndex(at >= 0 ? at + 6 : sql.length));
  if (at >= 0) this.editor.setSelection(this.editor.posFromIndex(at + 6), this.editor.posFromIndex(sql.length - 1));
}

export function sqlFormat() {
  if (!this.editor) return;
  const cm = this.editor;
  if (/\bDELIMITER\b/i.test(cm.getValue())) {
    return this.alertDialog({ type: 'info', title: 'Cannot format this script', message: 'Scripts with DELIMITER (procedures, triggers) are left as they are.' });
  }
  if (cm.somethingSelected()) cm.replaceSelection(formatSql(cm.getSelection()), 'around');
  else {
    const text = cm.getValue();
    const formatted = formatSql(text);
    if (formatted !== text.trim()) cm.setValue(formatted);
  }
  cm.focus();
}

function describeResult(r) {
  if (!r.ok) return r.error;
  if (r.kind === 'rows') return `${Number(r.total).toLocaleString()} ${r.total === 1 ? 'row' : 'rows'} in ${fmtMs(r.time_ms)}`;
  const n = r.affected ?? 0;
  return `${r.verb || 'Query'} OK · ${Number(n).toLocaleString()} ${n === 1 ? 'row' : 'rows'} affected · ${fmtMs(r.time_ms)}`;
}

/** Load another page of one result (re-runs only that statement). */
export async function sqlGoToPage(i, page) {
  const r = (this.S.sqlResults || [])[i];
  if (!r || !r.paginated || this.S.sqlRunning) return;
  this.S.sqlRunning = true;
  this.renderSqlResults();
  const next = await execStatement(this, r.sql, Math.max(1, page));
  this.S.sqlRunning = false;
  this.S.sqlResults[i] = next;
  this.renderSqlResults();
}

export function sqlShowResult(i) {
  this.S.sqlActive = i;
  this.renderSqlResults();
}

/** Export the active result: every row, not just the page on screen. */
export async function exportQuery(format) {
  const r = (this.S.sqlResults || [])[this.S.sqlActive];
  if (!r || r.kind !== 'rows' || !r.data.length) return this.showMsg('No query results to export.', 'error');
  let rows = r.data;
  if (r.paginated && r.total > r.data.length) {
    if (r.total > EXPORT_CAP) {
      const ok = await this.confirmDialog({
        type: 'warning', title: 'Large export',
        message: `This result has ${r.total.toLocaleString()} rows. The first ${EXPORT_CAP.toLocaleString()} will be exported. Use the Export tab or a LIMIT for more control.`,
        confirmText: 'Export'
      });
      if (!ok) return;
    }
    const perPage = this.S.perPage;
    this.S.perPage = Math.min(r.total, EXPORT_CAP);
    this.showMsg(`Fetching ${this.S.perPage.toLocaleString()} rows to export…`);
    const all = await execStatement(this, r.sql, 1);
    this.S.perPage = perPage;
    if (!all.ok) return this.showAlertDialog('Export failed', all.error, 'error');
    rows = all.data;
  }
  exportData(format, `query_${this.S.db || 'result'}`, r.headers, rows);
  this.showMsg(`Exported ${rows.length.toLocaleString()} rows as ${format.toUpperCase()}`);
}

// ─── DATABASE / AUTOCOMPLETE ────────────────────────────────

export function sqlSetDb(db) {
  if (!db || db === this.S.db) return;
  this.switchDb(db);
  this.saveLocalState();
  this.loadDbColumns(db);
  this.renderSqlToolbar();
}

/** Every table's columns for autocomplete (once per database). */
export async function loadDbColumns(db = this.S.db) {
  if (!db) return;
  if (!this.APP.dbColumns) this.APP.dbColumns = {};
  if (this.APP.dbColumns[db]) return this.applySqlHints();
  try {
    const res = await fetch(`${this.apiUrl}?action=db_columns&db=${encodeURIComponent(db)}`);
    const data = await res.json();
    if (res.ok && data.tables) this.APP.dbColumns[db] = data.tables;
  } catch (e) { /* autocomplete falls back to table names */ }
  if (db === this.S.db) this.applySqlHints();
}

export function applySqlHints() {
  if (!this.editor) return;
  const cols = this.APP.dbColumns?.[this.S.db];
  const tables = {};
  if (cols) Object.entries(cols).forEach(([t, c]) => { tables[t] = c; });
  else (this.APP.databases[this.S.db]?.tables || []).forEach(t => { tables[t] = this.APP.colHeaders[t] || []; });
  this.editor.setOption('hintOptions', { tables, completeSingle: false });
  this.renderSqlSide();
}

// ─── RENDER ─────────────────────────────────────────────────

export function renderSqlPanel(p, msgHtml) {
  // Re-use the live editor: only the toolbar and results change.
  if (editorAlive(this)) {
    if (this.S.sqlDraft !== undefined && this.editor.getValue() !== this.S.sqlDraft) this.editor.setValue(this.S.sqlDraft);
    this.renderSqlToolbar();
    this.renderSqlSide();
    this.applySqlMode();
    this.renderSqlResults();
    return;
  }

  const initial = this.S.sqlDraft ?? this.S.currentQuery ?? (this.S.table ? `SELECT *\nFROM \`${this.S.table}\`;` : 'SHOW TABLES;');
  let height = 240;
  try { height = parseInt(localStorage.getItem(HEIGHT_KEY), 10) || 240; } catch (e) { /* default */ }

  p.innerHTML = `${msgHtml}
    <div class="sqlx">
      <div class="sqlx-summary" id="sqlx-summary" hidden></div>
      <div class="sqlx-edit" id="sqlx-edit">
        <div class="sqlx-toolbar" id="sqlx-toolbar"></div>
        <div class="sqlx-body">
          <div class="sqlx-main">
            <div class="sqlx-editor" id="sqlx-editor-wrap"><textarea id="sql-input">${esc(initial)}</textarea></div>
            <div class="sqlx-resize" title="Drag to resize the editor" onmousedown="window._dbm.startSqlResize(event)"></div>
            <div class="sqlx-status" id="sqlx-status"></div>
          </div>
          <aside class="sqlx-cols" id="sqlx-cols" aria-label="Columns"></aside>
        </div>
        <div class="sqlx-templates" id="sqlx-templates"></div>
      </div>
      <div class="sqlx-results" id="sqlx-results" aria-live="polite"></div>
    </div>`;

  const ta = document.getElementById('sql-input');
  if (typeof CodeMirror !== 'undefined' && ta) {
    this.editor = CodeMirror.fromTextArea(ta, {
      mode: 'text/x-mysql',
      theme: this.S.theme === 'dark' ? 'dracula' : 'default',
      lineNumbers: true,
      indentWithTabs: true,
      smartIndent: true,
      extraKeys: {
        'Ctrl-Enter': () => this.runQuery('smart'),
        'Cmd-Enter': () => this.runQuery('smart'),
        'Shift-Ctrl-Enter': () => this.runQuery('all'),
        'Shift-Cmd-Enter': () => this.runQuery('all'),
        'Ctrl-S': () => this.saveCurrentQuery(false),
        'Cmd-S': () => this.saveCurrentQuery(false),
        'Ctrl-Space': 'autocomplete'
      }
    });
    this.editor.setSize(null, height);
    this.editor.on('change', (cm) => { this.S.sqlDraft = cm.getValue(); });
    this.editor.on('cursorActivity', () => this.updateSqlStatus());
    this.editor.on('keyup', (cm, event) => {
      const ignore = [13, 8, 9, 32, 37, 38, 39, 40, 27, 16, 17, 18, 91];
      if (!ignore.includes(event.keyCode) && !cm.state.completionActive && /[\w.`]/.test(event.key || '')) {
        CodeMirror.commands.autocomplete(cm, null, { completeSingle: false });
      }
    });
    this.applySqlHints();
    this.loadDbColumns();
  }
  this.renderSqlToolbar();
  this.renderSqlSide();
  this.applySqlMode();
  this.renderSqlResults();
  this.updateSqlStatus();
}

export function renderSqlToolbar() {
  const bar = document.getElementById('sqlx-toolbar');
  if (!bar) return;
  const dbs = Object.keys(this.APP.databases || {});
  const open = this.S.openQuery && this.S.openQuery.db === this.S.db
    ? this.savedQueries(this.S.db).find(q => q.id === this.S.openQuery.id) : null;
  const running = !!this.S.sqlRunning;
  bar.innerHTML = `
    <div class="sqlx-tb-group">
      <button type="button" class="btn primary" id="run-query-btn" onclick="window._dbm.runQuery('smart')" ${running ? 'disabled' : ''}
              title="Run the selection, or the statement at the cursor (Ctrl+Enter)">
        ${running ? '<span class="spinner"></span> Running…' : `${ti('player-play')} Run`}</button>
      <button type="button" class="btn" onclick="window._dbm.runQuery('all')" ${running ? 'disabled' : ''} title="Run every statement in the editor (Ctrl+Shift+Enter)">${ti('player-track-next')} Run all</button>
      <button type="button" class="btn" onclick="window._dbm.runQuery('explain')" ${running ? 'disabled' : ''} title="Show how MySQL will execute the statement at the cursor">${ti('route')} Explain</button>
    </div>
    <label class="sqlx-db" title="Database the queries run in">
      ${ti('database')}
      <select aria-label="Database" onchange="window._dbm.sqlSetDb(this.value)">
        ${dbs.map(d => `<option value="${esc(d)}" ${d === this.S.db ? 'selected' : ''}>${esc(d)}</option>`).join('')}
      </select>
    </label>
    <div class="sqlx-tb-group">
      ${open ? `<span class="sql-open-query" title="Saved query">${ti('file-code')}${esc(open.name)}</span>` : ''}
      <button type="button" class="btn" onclick="window._dbm.saveCurrentQuery(false)" title="${open ? 'Save changes' : 'Save as a named query in the sidebar'} (Ctrl+S)">${ti('device-floppy')} ${open ? 'Save' : 'Save query'}</button>
      ${open ? `<button type="button" class="btn" onclick="window._dbm.saveCurrentQuery(true)" title="Save a copy under a new name">${ti('copy')} Save as…</button>` : ''}
      <button type="button" class="btn" id="sqlx-history-btn" onclick="window._dbm.toggleSqlHistory(this)" aria-haspopup="true" title="Queries you ran before">${ti('history')} History</button>
      <button type="button" class="btn" onclick="window._dbm.sqlClearEditor()" title="Clear the editor">${ti('eraser')}</button>
    </div>`;
}

/** Status line under the editor: cursor, statement count, what Ctrl+Enter will run. */
export function updateSqlStatus() {
  const el = document.getElementById('sqlx-status');
  if (!el || !this.editor) return;
  const cm = this.editor;
  const pos = cm.getCursor();
  const stmts = splitStatements(cm.getValue());
  const sel = cm.somethingSelected();

  // Shade the statement Ctrl+Enter will run, when there's more than one.
  if (this._sqlMark) { this._sqlMark.clear(); this._sqlMark = null; }
  if (!sel && stmts.length > 1) {
    const cur = statementAt(stmts, cm.indexFromPos(pos));
    if (cur) {
      const from = cm.posFromIndex(cur.start + (cm.getValue().slice(cur.start, cur.end).search(/\S/) || 0));
      this._sqlMark = cm.markText(from, cm.posFromIndex(cur.end), { className: 'cm-current-stmt' });
    }
  }
  const runs = sel ? 'the selection' : (stmts.length > 1 ? 'the highlighted statement' : 'the query');
  el.innerHTML = `
    <span>Ln ${pos.line + 1}, Col ${pos.ch + 1}</span>
    <span>${stmts.length} ${stmts.length === 1 ? 'statement' : 'statements'}</span>
    <span class="sqlx-keys"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs ${runs} · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> runs all · <kbd>Ctrl</kbd>+<kbd>Space</kbd> suggests</span>`;
}

export function renderSqlResults() {
  const box = document.getElementById('sqlx-results');
  if (!box) return;
  const results = this.S.sqlResults || [];
  const running = !!this.S.sqlRunning;

  if (!results.length) {
    box.innerHTML = running
      ? '<div class="sqlx-placeholder"><span class="spinner"></span> Running…</div>'
      : `<div class="sqlx-placeholder">${ti('terminal-2')} Results appear here. Put the cursor in a statement and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.</div>`;
    return;
  }

  const active = Math.min(this.S.sqlActive || 0, results.length - 1);
  const tabs = results.length > 1 ? `
    <div class="sqlx-tabs" role="tablist" aria-label="Results">
      ${results.map((r, i) => {
        const icon = !r.ok ? 'circle-x' : r.kind === 'rows' ? 'table' : 'circle-check';
        const label = !r.ok ? 'error' : r.kind === 'rows' ? `${Number(r.total).toLocaleString()} rows` : `${r.affected ?? 0} affected`;
        return `<button type="button" role="tab" aria-selected="${i === active}" class="sqlx-tab ${i === active ? 'active' : ''} ${!r.ok ? 'err' : ''}"
                  title="${esc(r.sql.slice(0, 300))}" onclick="window._dbm.sqlShowResult(${i})">${ti(icon)}<span>${i + 1}</span><span class="sqlx-tab-meta">${label}</span></button>`;
      }).join('')}
      ${running ? '<span class="sqlx-tab-running"><span class="spinner"></span></span>' : ''}
    </div>` : '';

  const r = results[active];
  let body;
  if (!r.ok) {
    body = `
      <div class="sqlx-error" role="alert">
        <div class="sqlx-error-title">${ti('alert-triangle')} Query failed</div>
        <div class="sqlx-error-msg">${esc(r.error)}</div>
        ${r.sql ? `<pre class="sqlx-sql">${esc(r.sql)}</pre>` : ''}
      </div>`;
  } else if (r.kind === 'message') {
    body = `
      <div class="sqlx-ok">
        ${ti('circle-check')}
        <span><strong>${esc(r.verb || 'Query')} OK</strong> · ${Number(r.affected ?? 0).toLocaleString()} ${r.affected === 1 ? 'row' : 'rows'} affected${r.insertId ? ` · new id <code>${esc(r.insertId)}</code>` : ''} · ${fmtMs(r.time_ms)}</span>
      </div>
      <pre class="sqlx-sql">${esc(r.sql)}</pre>`;
  } else {
    const pages = r.paginated ? Math.max(1, Math.ceil(r.total / r.perPage)) : 1;
    const from = r.total ? (r.page - 1) * r.perPage + 1 : 0;
    const to = r.paginated ? Math.min(r.page * r.perPage, r.total) : r.data.length;
    const perPage = parseInt(this.S.perPage, 10) || 25;
    // Same look as Browse: numbers line up on the right. A column counts as numeric
    // when every non-NULL value on this page is a plain number.
    const rows = r.data.map(row => (Array.isArray(row) ? row : r.headers.map(h => row[h])));
    const isNum = v => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v));
    const numCols = r.headers.map((_, ci) => {
      let seen = false;
      for (const row of rows) {
        const v = row[ci];
        if (v === null || v === undefined) continue;
        if (!isNum(v)) return false;
        seen = true;
      }
      return seen;
    });
    const ed = editInfo(this, r);
    const canEdit = !!(ed && ed.cols);
    const isPkCol = (ci) => canEdit && ed.pkIdx.includes(ci);
    const cellAttrs = (ri, ci) => {
      const cls = [numCols[ci] ? 'num' : '', canEdit ? (isPkCol(ci) ? 'sqlx-pk' : 'sqlx-editable') : '', this.S.sqlFlash === `${ri}:${ci}` ? 'sqlx-flash' : ''].filter(Boolean).join(' ');
      return `${cls ? ` class="${cls}"` : ''}${canEdit ? ` data-r="${ri}" data-c="${ci}"${isPkCol(ci) ? ' title="Primary key (not editable here)"' : ' ondblclick="window._dbm.sqlEditCell(this)"'}` : ''}`;
    };
    const editNote = canEdit
      ? `<span class="sqlx-edit-note ok" title="Saves with UPDATE … WHERE ${esc(ed.pk.join(' AND '))}">${ti('pencil')} Double-click a cell to edit <code>${esc(ed.table)}</code></span>`
      : ed && ed.why ? `<span class="sqlx-edit-note" title="Results can be edited when the query is a SELECT from one table that includes its primary key">${ti('lock')} Read-only: ${esc(ed.why)}</span>` : '';
    body = `
      <div class="sqlx-meta">
        <span><strong>${Number(r.total).toLocaleString()}</strong> ${r.total === 1 ? 'row' : 'rows'} · ${fmtMs(r.time_ms)}${r.paginated && r.total > r.data.length ? ` · showing ${from.toLocaleString()}–${to.toLocaleString()}` : ''}${editNote}</span>
        <span class="sqlx-meta-actions">
          <button type="button" class="btn btn-sm" onclick="window._dbm.exportQuery('csv')" title="Export all rows as CSV">${ti('file-type-csv')} CSV</button>
          <button type="button" class="btn btn-sm" onclick="window._dbm.exportQuery('json')" title="Export all rows as JSON">${ti('braces')} JSON</button>
        </span>
      </div>
      <div class="tbl-wrapper sqlx-grid ${running ? 'is-loading' : ''}">
        <table class="data-tbl dgrid dgrid-bordered">
          <thead><tr><th class="sqlx-rownum">#</th>${r.headers.map((h, ci) => `<th${numCols[ci] ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((row, ri) => `<tr><td class="sqlx-rownum">${from + ri}</td>${row.map((c, ci) =>
            c === null || c === undefined ? `<td${cellAttrs(ri, ci)}><span class="null-val">NULL</span></td>`
              : `<td${cellAttrs(ri, ci)}${!canEdit && String(c).length > 60 && String(c).length < 2000 ? ` title="${esc(c)}"` : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')
            || `<tr><td colspan="${r.headers.length + 1}" class="st-empty">No rows.</td></tr>`}</tbody>
        </table>
      </div>
      ${r.paginated && r.total > perPage ? `
      <div class="table-footer-bar">
        <div class="footer-left"><span class="footer-rows-info">Page ${r.page} of ${pages}</span></div>
        <div class="footer-pagination">
          <select class="search-input per-page-select" style="min-width:105px; width:auto; padding:4px 8px;" onchange="window._dbm.setPerPage(this.value)" aria-label="Rows per page">
            ${[25, 50, 100, 250, 500, 1000].map(n => `<option value="${n}" ${perPage === n ? 'selected' : ''}>${n} / page</option>`).join('')}
          </select>
          <button class="btn btn-sm" onclick="window._dbm.sqlGoToPage(${active}, ${r.page - 1})" ${r.page <= 1 ? 'disabled' : ''}>${ti('chevron-left')} Prev</button>
          <button class="btn btn-sm" onclick="window._dbm.sqlGoToPage(${active}, ${r.page + 1})" ${r.page >= pages ? 'disabled' : ''}>Next ${ti('chevron-right')}</button>
        </div>
      </div>` : ''}`;
  }
  box.innerHTML = tabs + body;
}

// ─── HISTORY ────────────────────────────────────────────────

export function toggleSqlHistory(btn) {
  const existing = document.getElementById('sqlx-history');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.id = 'sqlx-history';
  pop.className = 'sqlx-history';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Query history');
  pop.innerHTML = `
    <div class="sqlx-history-head">
      <input type="search" placeholder="Search history…" aria-label="Search history" spellcheck="false">
      <button type="button" class="btn btn-sm" data-act="clear">Clear</button>
    </div>
    <div class="sqlx-history-list" role="list"></div>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - 460, window.innerWidth - 468))}px`;

  const listEl = pop.querySelector('.sqlx-history-list');
  const search = pop.querySelector('input');
  const draw = () => {
    const q = search.value.toLowerCase().trim();
    const items = readHistory(this).filter(h => !q || h.sql.toLowerCase().includes(q) || (h.db || '').toLowerCase().includes(q));
    listEl.innerHTML = items.length ? items.map((h, i) => `
      <button type="button" class="sqlx-history-item" role="listitem" data-i="${i}" title="${esc(h.sql.slice(0, 600))}">
        <span class="sqlx-history-sql">${ti(h.ok ? 'circle-check' : 'circle-x')}<code>${esc(h.sql.replace(/\s+/g, ' ').slice(0, 140))}</code></span>
        <span class="sqlx-history-meta">${esc(h.db || '')} · ${esc(timeAgo(h.at))} · ${esc(fmtMs(h.ms))}</span>
      </button>`).join('')
      : `<div class="sqlx-history-empty">${q ? 'No match.' : 'Queries you run show up here.'}</div>`;
    listEl.querySelectorAll('.sqlx-history-item').forEach(b => {
      b.onclick = () => {
        const h = items[Number(b.dataset.i)];
        close();
        if (h.db && h.db !== this.S.db && this.APP.databases[h.db]) this.sqlSetDb(h.db);
        if (this.editor) { this.sqlEdit(); this.editor.setValue(h.sql); this.editor.focus(); this.editor.setCursor(this.editor.lineCount(), 0); }
        else this.S.sqlDraft = h.sql;
      };
    });
  };
  const onDown = (e) => { if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); } };
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  pop.querySelector('[data-act="clear"]').onclick = async () => {
    if (!(await this.confirmDialog({ type: 'warning', title: 'Clear query history?', message: 'History is kept in this browser only.', confirmText: 'Clear' }))) return;
    try {
      const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
      delete all[connKey(this)];
      localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
    draw();
  };
  search.addEventListener('input', draw);
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  draw();
  search.focus();
}

// ─── EDITOR SIZE / MISC ─────────────────────────────────────

export function startSqlResize(e) {
  if (!this.editor) return;
  e.preventDefault();
  const startY = e.clientY;
  const startH = this.editor.getWrapperElement().offsetHeight;
  const move = (ev) => {
    const h = Math.max(100, Math.min(window.innerHeight * 0.75, startH + ev.clientY - startY));
    this.editor.setSize(null, h);
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.style.userSelect = '';
    try { localStorage.setItem(HEIGHT_KEY, String(this.editor.getWrapperElement().offsetHeight)); } catch (err) { /* ignore */ }
    this.editor.refresh();
  };
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

export function sqlClearEditor() {
  if (!this.editor) return;
  this.editor.setValue('');
  this.S.openQuery = null;
  this.renderSqlToolbar();
  this.editor.focus();
}
