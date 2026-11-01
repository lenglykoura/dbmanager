import { esc, escJs, ti } from './util.js';
import { formatBytes } from './export.js';
import { columnInputSpec } from './cellinput.js';

export function showMsg(m, t = 'success') {
  if (!this.S.logs) this.S.logs = [];

  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  this.S.logs.push({ time, msg: m, type: t });

  if (this.S.logs.length > 100) this.S.logs = this.S.logs.slice(-100);

  // The console stays collapsed; the newest message shows on its bar instead.
  if (typeof this.saveLocalState === 'function') this.saveLocalState();

  this.renderTerminal();
}

export function renderTerminal() {
  const body = document.getElementById('term-body');
  const countPill = document.getElementById('term-count-pill');
  if (!body) return;

  const logs = this.S.logs || [];
  const reversedLogs = [...logs].reverse();
  const errorCount = logs.filter(l => l.type === 'error').length;

  // Newest message on the collapsed bar (hidden by CSS while the console is open).
  const lastEl = document.getElementById('term-last');
  if (lastEl) {
    const l = logs[logs.length - 1];
    lastEl.className = `term-last ${l ? esc(l.type) : ''}`;
    lastEl.title = l ? l.msg : '';
    lastEl.innerHTML = l
      ? `<span class="term-log-tag ${esc(l.type)}">${esc(l.type)}</span><span class="term-log-time">[${esc(l.time)}]</span><span class="term-last-msg">${esc(l.msg)}</span>`
      : '';
  }

  if (countPill) {
    if (errorCount > 0) {
      countPill.textContent = `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`;
      countPill.className = 'term-count-pill has-error';
    } else {
      countPill.textContent = `${logs.length} ${logs.length === 1 ? 'log' : 'logs'}`;
      countPill.className = 'term-count-pill';
    }
  }

  if (reversedLogs.length === 0) {
    body.innerHTML = '<div style="color:#64748b; font-size:11px; padding:12px; font-style:italic; text-align:center;">No console logs yet.</div>';
    return;
  }

  body.innerHTML = reversedLogs.map((l) => `
    <div class="term-log-entry ${esc(l.type)}">
      <span class="term-log-tag ${esc(l.type)}">${esc(l.type)}</span>
      <span class="term-log-time">[${esc(l.time)}]</span>
      <span class="term-log-msg">${esc(l.msg)}</span>
      <button class="term-copy-btn" onclick="window._dbm.copySingleLog('${escJs(l.msg)}')">Copy</button>
    </div>
  `).join('');

  body.scrollTop = 0;
}

export function clearTerminal() {
  this.S.logs = [];
  if (typeof this.saveLocalState === 'function') this.saveLocalState();
  this.renderTerminal();
}

export function updateStatus() {
  const d = document.getElementById('status-db');
  const t = document.getElementById('status-tbl');
  if (d) d.textContent = `DB: ${this.S.db || '—'}`;
  if (t) t.textContent = `Table: ${this.S.table || '—'}`;
}

export function togglePasswordVisibility() {
  const passInp = document.getElementById('inp-pass');
  const btn = document.getElementById('btn-toggle-pass');
  if (!passInp || !btn) return;
  const isPass = passInp.type === 'password';
  passInp.type = isPass ? 'text' : 'password';
  btn.innerHTML = isPass
    ? `<i class="ti ti-eye-off" aria-hidden="true" style="font-size:15px"></i>`
    : `<i class="ti ti-eye" aria-hidden="true" style="font-size:15px"></i>`;
  btn.title = isPass ? "Hide password" : "Show password";
}

export function renderShell() {
  if (!this.S.isLoggedIn) {
    this.container.innerHTML = `
          <div id="login-screen">
            <div class="login-box">
              <div class="login-logo">DB<em style="color:var(--accent)">Manager</em></div>
              <div class="login-sub">MySQL / MariaDB Administration</div>
              <div class="form-row" style="margin-bottom:12px;">
                <label>Host / Port</label>
                <input value="${esc(this.S.host || 'localhost:3306')}" id="inp-host" placeholder="localhost:3306" />
              </div>
              <div class="form-row" style="margin-bottom:12px;">
                <label>Username</label>
                <input value="${esc(this.S.user || 'root')}" id="inp-user" placeholder="root" />
              </div>
              <div class="form-row" style="margin-bottom:12px;">
                <label>Password</label>
                <div class="pass-wrapper">
                  <input type="password" placeholder="••••••••" id="inp-pass" />
                  <button type="button" class="pass-toggle-btn" id="btn-toggle-pass" onclick="window._dbm.togglePasswordVisibility()" title="Show password" aria-label="Toggle password visibility">
                    <i class="ti ti-eye" aria-hidden="true" style="font-size:15px"></i>
                  </button>
                </div>
              </div>
              <div class="form-row" style="margin-bottom:12px;">
                <label>Database (Optional)</label>
                <input value="${esc(this.S.savedDb || '')}" placeholder="e.g. my_database" id="inp-db" />
              </div>
              
              <div class="login-remember">
                <label>
                  <input type="checkbox" id="inp-remember" ${this.S.rememberConn ? 'checked' : ''} style="accent-color:var(--accent); cursor:pointer;" />
                  <span>Remember host & username</span>
                </label>
              </div>

              <button class="login-btn" id="btn-connect" onclick="window._dbm.doLogin()">
                <span id="btn-connect-text">Connect <i class="ti ti-arrow-right" aria-hidden="true"></i></span>
              </button>
            </div>
          </div>`;

    const loginInputs = this.container.querySelectorAll('#login-screen input');
    loginInputs.forEach(input => {
      input.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.doLogin(); });
    });
  } else {
    this.container.innerHTML = `
          <div id="shell">
            <div id="topbar">
              <button class="top-btn" style="padding:6px; margin-right:4px; border:none; background:transparent;" onclick="window._dbm.toggleSidebar()" title="Toggle Sidebar">
                  <i class="ti ti-menu-2" aria-hidden="true" style="font-size:18px"></i>
              </button>
              
              <div class="brand">DB<em>Manager</em></div>
              <div class="conn-pill"><div class="conn-dot"></div><span id="conn-label">${esc(this.S.user)}@${esc(this.S.host)}</span></div>
              
              <div class="top-spacer"></div>

              <button class="top-btn" id="theme-toggle-btn" style="padding:6px; margin-right:8px; border:none; background:transparent;" onclick="window._dbm.toggleTheme()" title="Toggle Theme">
                  ${this.S.theme === 'dark'
        ? '<i class="ti ti-moon" aria-hidden="true" style="font-size:16px"></i>'
        : '<i class="ti ti-sun" aria-hidden="true" style="font-size:16px"></i>'
      }
              </button>

              <button class="top-btn danger" onclick="window._dbm.confirmLogout()">Logout</button>
            </div>
            <div id="main">
              <div id="sidebar" class="${this.S.sidebarOpen ? '' : 'is-closed'}" ${this.S.sidebarOpen ? '' : 'inert'}>
                <div class="sidebar-header">
                  <div class="sidebar-search-box">
                    <i class="ti ti-search search-icon" aria-hidden="true" style="font-size:13px"></i>
                    <input id="sidebar-search-input" class="sidebar-search" placeholder="Search tables or databases…" oninput="window._dbm.onSidebarSearch(this.value)" />
                    <button id="sidebar-search-clear" class="search-clear-btn" style="display:none;" onclick="window._dbm.clearSidebarSearch()" title="Clear search"><i class="ti ti-x" aria-hidden="true"></i></button>
                  </div>
                  <div class="sidebar-toolbar">
                    <span class="sidebar-title">
                      Databases <span class="db-total-badge" id="db-total-count">${Object.keys(this.APP.databases || {}).length}</span>
                    </span>
                    <div class="sidebar-tools">
                      <button class="tool-btn" id="btn-toggle-all-dbs" onclick="window._dbm.toggleAllDbs()" title="Expand / Collapse All">
                        <i class="ti ti-chevrons-down" aria-hidden="true" style="font-size:13px"></i>
                      </button>
                      <button class="tool-btn" id="btn-refresh-sidebar" onclick="window._dbm.refreshSidebar(this)" title="Refresh Databases & Tables">
                        <i class="ti ti-refresh" aria-hidden="true" style="font-size:12px"></i>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="sidebar-scroll" id="sidebar-content"></div>
                <div id="sidebar-resizer" onmousedown="window._dbm.startSidebarResize(event)"></div>
              </div>
              <div id="sidebar-backdrop" class="sidebar-backdrop ${this.S.sidebarOpen && window.innerWidth <= 768 ? 'is-open' : ''}" onclick="window._dbm.toggleSidebar()"></div>
              <div id="content" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
                <div id="tabbar" style="flex-shrink: 0;">
                  <a class="tab ${this.S.tab === 'objects' ? 'active' : ''}" id="tab-objects" data-tab="objects" href="#tab=objects" onclick="window._dbm.onTabLinkClick(event, 'objects')"><i class="ti ti-list-details" aria-hidden="true"></i> Objects</a>
                  <a class="tab ${this.S.tab === 'browse' ? 'active' : ''}" id="tab-browse" data-tab="browse" href="#tab=browse" onclick="window._dbm.onTabLinkClick(event, 'browse')"><i class="ti ti-table" aria-hidden="true"></i> Browse</a>
                  <a class="tab ${this.S.tab === 'structure' ? 'active' : ''}" id="tab-structure" data-tab="structure" href="#tab=structure" onclick="window._dbm.onTabLinkClick(event, 'structure')"><i class="ti ti-layout-columns" aria-hidden="true"></i> Structure</a>
                  <a class="tab ${this.S.tab === 'sql' ? 'active' : ''}" id="tab-sql" data-tab="sql" href="#tab=sql" onclick="window._dbm.onTabLinkClick(event, 'sql')"><i class="ti ti-code" aria-hidden="true"></i> SQL</a>
                  <a class="tab ${this.S.tab === 'export' ? 'active' : ''}" id="tab-export" data-tab="export" href="#tab=export" onclick="window._dbm.onTabLinkClick(event, 'export')"><i class="ti ti-download" aria-hidden="true"></i> Export</a>
                  <a class="tab ${this.S.tab === 'import' ? 'active' : ''}" id="tab-import" data-tab="import" href="#tab=import" onclick="window._dbm.onTabLinkClick(event, 'import')"><i class="ti ti-upload" aria-hidden="true"></i> Import</a>
                </div>
                
                <div id="panel" style="flex: 1; overflow-y: auto;"></div>
                
                <div id="terminal-wrapper" class="${this.S.terminalOpen ? 'is-open' : ''}" style="height: ${this.S.terminalOpen ? `${this.S.terminalHeight || 180}px` : '34px'};">
                    <div id="term-resizer" onmousedown="window._dbm.startTerminalResize(event)"></div>
                    <div class="term-header">
                        <div class="term-header-left" onclick="window._dbm.toggleTerminal()">
                            <span id="term-toggle-btn">${this.S.terminalOpen ? '<i class="ti ti-chevron-down" aria-hidden="true"></i>' : '<i class="ti ti-chevron-up" aria-hidden="true"></i>'}</span>
                            <span class="term-header-title">
                                <i class="ti ti-terminal-2" aria-hidden="true" style="font-size:12px"></i>
                                Console Output
                            </span>
                            <span id="term-count-pill" class="term-count-pill">${(this.S.logs || []).length} logs</span>
                            <span id="term-last" class="term-last" role="status" aria-live="polite"></span>
                        </div>
                        <div class="term-header-right">
                            <button class="term-btn" onclick="window._dbm.copyAllLogs(); event.stopPropagation();" title="Copy all logs">
                                <i class="ti ti-copy" aria-hidden="true" style="font-size:11px"></i>
                                Copy All
                            </button>
                            <button class="term-btn" onclick="window._dbm.confirmClearTerminal(); event.stopPropagation();" title="Clear console">
                                <i class="ti ti-x" aria-hidden="true" style="font-size:11px"></i>
                                Clear
                            </button>
                        </div>
                    </div>
                    <div id="term-body" class="term-body" style="display: ${this.S.terminalOpen ? 'block' : 'none'};"></div>
                </div>
              </div>
            </div>
            <div id="statusbar">
              <div class="status-item green"><i class="ti ti-point-filled" aria-hidden="true"></i> Connected</div>
              <div class="status-item" id="status-db">DB: —</div>
              <div class="status-item" id="status-tbl">Table: —</div>
            </div>
          </div>`;
    this.renderSidebar();
    this.renderTerminal();
    this.updateStatus();
  }
}

/**
 * Shown in place of the grid when a table or view can't be opened. The common
 * case after importing a database from another server is MySQL error 1449: the
 * view's creator ("definer") doesn't exist here, so MySQL won't run the view.
 */
export function renderLoadError(db, table, message) {
  const panel = document.getElementById('panel');
  if (!panel) return;
  const isView = (this.APP.databases[db]?.views || []).includes(table);
  const definer = /\b1449\b.*definer \('([^']*)'@'([^']*)'\)/i.exec(message || '');
  const jsDb = escJs(db);
  const jsT = escJs(table);
  const kind = isView ? 'view' : 'table';

  let explain = '<p>MySQL returned an error while reading it. The technical details are below.</p>';
  const actions = [];
  if (definer && isView) {
    explain = `
      <p>This view was created by the MySQL user <code>'${esc(definer[1])}'@'${esc(definer[2])}'</code>,
         which doesn't exist on this server. A view runs with its creator's permissions, so MySQL refuses to run it.</p>
      <p>This usually happens after importing a database from another server. It can be fixed by making
         the user you're logged in as (<strong>${esc(this.S.user)}</strong>) the view's owner. The query itself stays the same.</p>`;
    actions.push(`<button class="btn primary" onclick="window._dbm.fixViewDefiner('${jsDb}', '${jsT}')">${ti('tool')} Fix the view</button>`);
    actions.push(`<button class="btn" onclick="window._dbm.openDefinition('${jsDb}', 'view', '${jsT}')">${ti('code')} View definition</button>`);
  } else if (definer) {
    explain = `
      <p>Something this table uses (often a trigger or a stored function) was created by the MySQL user
         <code>'${esc(definer[1])}'@'${esc(definer[2])}'</code>, which doesn't exist on this server, so MySQL refuses to run it.</p>`;
  }
  actions.push(`<button class="btn" onclick="window._dbm.handleDbRowClick('${jsDb}')">${ti('list-details')} Back to ${esc(db)}</button>`);

  panel.innerHTML = `
    <div class="load-error" role="alert">
      <div class="load-error-icon">${ti('alert-triangle')}</div>
      <div class="load-error-title">Can't open ${kind} <code>${esc(table)}</code></div>
      <div class="load-error-text">${explain}</div>
      <div class="load-error-actions">${actions.join('')}</div>
      <details class="load-error-details">
        <summary>Technical details</summary>
        <code>${esc(message)}</code>
      </details>
    </div>`;
}

export function renderSidebar(filter = null) {
  const el = document.getElementById('sidebar-content');
  if (!el) return;

  const searchInput = document.getElementById('sidebar-search-input');
  const activeFilter = filter !== null ? filter : (searchInput ? searchInput.value : '');
  const filterLower = (activeFilter || '').toLowerCase().trim();

  const countEl = document.getElementById('db-total-count');
  const dbs = Object.entries(this.APP.databases || {});
  if (countEl) countEl.textContent = dbs.length;

  let html = '';

  dbs.forEach(([db, info]) => {
    const isActiveDb = this.S.db === db;
    const isOpen = this.S.expandedDbs.has(db);
    const tables = info.tables || [];

    const matchesDb = !filterLower || db.toLowerCase().includes(filterLower);
    // Search also finds saved queries, routines, triggers and events by name.
    const objs = this.APP.dbObjects?.[db];
    const childNames = [...tables, ...this.savedQueries(db).map(q => q.name),
      ...[...(objs?.routines || []), ...(objs?.triggers || []), ...(objs?.events || [])].map(o => o.name)];
    const hasChildMatch = !!filterLower && childNames.some(n => String(n).toLowerCase().includes(filterLower));

    if (!matchesDb && !hasChildMatch) return;

    const shouldExpand = isOpen || hasChildMatch;

    html += `
          <div class="db-row ${isActiveDb ? 'active' : ''} ${shouldExpand ? 'open' : ''}" data-db="${esc(db)}"
               onclick="window._dbm.handleDbRowClick('${escJs(db)}')"
               onmouseenter="window._dbm.prefetchDbTree('${escJs(db)}')"
               oncontextmenu="window._dbm.onDbContextMenu(event, '${escJs(db)}')"
               title="${esc(db)} (${tables.length} tables)">
            <span class="db-arrow" onclick="event.stopPropagation(); window._dbm.toggleDb('${escJs(db)}')">
              <i class="ti ti-chevron-right" aria-hidden="true" style="font-size:11px"></i>
            </span>
            <i class="ti ti-database db-icon" aria-hidden="true" style="font-size:14px"></i>
            <span class="db-name">${esc(db)}</span>
            ${this.pinButtonHtml(db)}
            <span class="db-count" title="${tables.length} tables">${tables.length}</span>
          </div>`;

    if (shouldExpand) {
      // Tables / Views / Functions / Triggers / Events / Queries / Backups folders.
      // A search that matches the database name itself shows everything in it.
      html += this.renderDbFolders(db, info, matchesDb && filterLower && !hasChildMatch ? '' : filterLower);
    }
  });

  html = this.renderPinnedSection(filterLower) + html;
  html = html || '<div style="padding:16px;color:var(--text3);font-size:11px;text-align:center;">No matching databases or tables</div>';

  // Opening a table or switching tabs re-renders often; skip the DOM work (and
  // any flicker) when nothing changed, and never lose the scroll position.
  if (el._lastHtml !== html) {
    const scrollTop = el.scrollTop;
    el.innerHTML = html;
    el._lastHtml = html;
    el.scrollTop = scrollTop;
  }

  // When a different table becomes active (e.g. opened from the Objects grid),
  // bring it into view only if it's off-screen.
  const activeKey = `${this.S.db}\u0000${this.S.table}`;
  if (this._sidebarActiveKey !== activeKey) {
    this._sidebarActiveKey = activeKey;
    const row = el.querySelector('.db-tables-container .tbl-row.active');
    if (row) {
      const r = row.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) {
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        row.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
      }
    }
  }
}

/**
 * Starts inline editing of a browse-grid cell. A cell holding SQL NULL shows a
 * "NULL" placeholder, which has to be cleared first so the user types into an
 * empty cell instead of appending to the word NULL.
 */
export function onCellDblClick(td) {
  if (td.dataset.pk === '1' || td.classList.contains('fk-cell-td') || td.classList.contains('enum-cell-td')) return;
  const colDef = (this.APP.schemas[this.S.table] || [])[parseInt(td.dataset.col, 10)];
  const spec = columnInputSpec(colDef);
  if (spec && this.beginTypedCellEdit(td, colDef, spec)) return;
  this.beginCellEdit(td);
}

/**
 * Edits a date / time / number cell with a real <input>: dates and times open
 * the browser's picker, numbers are checked against the column type as you type
 * (with a hint showing the allowed format) and are only saved when valid.
 * Returns false when the stored value can't be shown in that input, so the
 * caller falls back to plain text editing.
 */
export function beginTypedCellEdit(td, colDef, spec) {
  const tr = td.closest('tr');
  const rowIndex = tr ? parseInt(tr.dataset.row, 10) : 0;
  const colIndex = parseInt(td.dataset.col, 10);
  const current = this.APP.tableData[this.S.table]?.[rowIndex]?.[colIndex];
  const initial = current === null || current === undefined ? '' : spec.toInput(current);
  if (initial === undefined) return false;

  const attrs = Object.entries(spec.attrs || {}).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  td.classList.add('cell-editing');
  td.innerHTML = `
    <div class="cell-editor">
      <input class="cell-input cell-input-${spec.kind}" type="${spec.type}" ${attrs}
             value="${esc(initial)}" aria-label="${esc(colDef.n)}" spellcheck="false">
      ${colDef.null ? '<button type="button" class="cell-null-btn" tabindex="-1" title="Set to NULL">NULL</button>' : ''}
    </div>`;

  const input = td.querySelector('input');
  const nullBtn = td.querySelector('.cell-null-btn');
  const hint = document.createElement('div');
  hint.className = 'cell-hint';
  hint.setAttribute('role', 'status');
  document.body.appendChild(hint); // rows clip their contents, so the hint floats at page level

  let finished = false;
  const placeHint = () => {
    const r = input.getBoundingClientRect();
    hint.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - hint.offsetWidth - 8))}px`;
    hint.style.top = `${r.bottom + 4}px`;
  };
  const check = () => {
    const result = spec.parse(input.value);
    let error = result.ok ? '' : result.error;
    // A half-filled date/time input reports '' as its value but flags badInput.
    if (!error && input.validity?.badInput) error = 'Finish entering the value.';
    if (!error && result.value === '' && !colDef.null) error = `${colDef.n} is NOT NULL, so it needs a value.`;
    input.classList.toggle('invalid', !!error);
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    hint.textContent = error || spec.hint;
    hint.classList.toggle('error', !!error);
    placeHint();
    return error ? null : result;
  };
  const end = () => {
    finished = true;
    hint.remove();
    td.classList.remove('cell-editing');
  };
  const save = (value) => {
    end();
    this.saveCell(rowIndex, colIndex, { tagName: 'INPUT', value, style: input.style });
  };
  const cancel = () => {
    end();
    this.renderPanel();
  };

  input.addEventListener('input', check);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const result = check();
      if (result) save(result.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', () => {
    if (finished) return;
    const result = check();
    if (result) {
      save(result.value);
    } else {
      this.showMsg(`${colDef.n} not saved: ${hint.textContent}`, 'error');
      cancel();
    }
  });
  if (nullBtn) {
    nullBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    nullBtn.addEventListener('click', () => save(''));                 // '' on a nullable column = NULL
  }

  input.focus();
  if (spec.type === 'text') input.select();
  check();
  // The double-click counts as a user gesture, so the date/time picker can open right away.
  if (spec.picker && typeof input.showPicker === 'function') {
    try { input.showPicker(); } catch (e) { /* picker not allowed here; typing still works */ }
  }
  return true;
}

export function beginCellEdit(td) {
  const tr = td.closest('tr');
  const actualRowIndex = tr ? parseInt(tr.dataset.row, 10) : 0;
  const cIdx = parseInt(td.dataset.col, 10);

  td.contentEditable = 'true';
  td.dataset.oldVal = td.innerText.trim();
  if (td.dataset.null === '1') td.textContent = '';
  td.focus();

  const cleanup = () => {
    td.onblur = null;
    td.onkeydown = null;
    td.contentEditable = 'false';
  };

  td.onblur = () => {
    cleanup();
    this.saveCell(actualRowIndex, cIdx, td);
  };

  td.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      td.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      td.textContent = td.dataset.oldVal || '';
      cleanup();
    }
  };

  const s = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(td);
  r.collapse(false);
  s.removeAllRanges();
  s.addRange(r);
}

export function endCellEdit(td, rowIndex, colIndex) {
  td.contentEditable = 'false';
  this.saveCell(rowIndex, colIndex, td);
}

export function activateEnumSelect(container, rowIndex, colIndex) {
  const td = container.closest('td');
  if (!td || td.querySelector('select')) return;

  const table = this.S.table;
  const schema = this.APP.schemas[table] || [];
  const colDef = schema[colIndex] || {};
  const currentVal = this.APP.tableData[table]?.[rowIndex]?.[colIndex];

  const match = (colDef.t || '').match(/^enum\((.*)\)$/i);
  let opts = [];
  if (match) {
    const rawOptions = match[1];
    const regex = /'((?:''|[^'])*)'/g;
    let m;
    while ((m = regex.exec(rawOptions)) !== null) {
      opts.push(m[1].replace(/''/g, "'"));
    }
  }

  const optionsHtml = opts.map(o => {
    const isSel = String(currentVal) === String(o);
    return `<option value="${esc(o)}" ${isSel ? 'selected' : ''}>${esc(o)}</option>`;
  }).join('');

  td.innerHTML = `
    <select class="cell-select"
            style="width:100%; height:100%; padding:8px 12px; background:var(--bg1); border:1px solid var(--accent); outline:none; font-family:inherit; font-size:inherit; cursor:pointer;"
            onchange="window._dbm.saveCell(${rowIndex}, ${colIndex}, this)"
            onblur="window._dbm.deactivateEnumSelect(this, ${rowIndex}, ${colIndex})">
        ${colDef.null ? `<option value="" ${currentVal === null ? 'selected' : ''}>[NULL]</option>` : ''}
        ${optionsHtml}
    </select>
  `;

  const sel = td.querySelector('select');
  if (sel) {
    sel.focus();
    if (typeof sel.showPicker === 'function') {
      try { sel.showPicker(); } catch (e) {}
    }
  }
}

export function deactivateEnumSelect(selectEl, rowIndex, colIndex) {
  const td = selectEl.closest('td');
  if (!td) return;
  setTimeout(() => {
    if (!td.parentNode) return;
    const table = this.S.table;
    const val = this.APP.tableData[table]?.[rowIndex]?.[colIndex];
    td.innerHTML = `
      <div class="fk-cell-view" onclick="window._dbm.activateEnumSelect(this, ${rowIndex}, ${colIndex})" title="Click to change" style="width:100%; height:100%; padding:8px 12px; display:flex; align-items:center; justify-content:space-between; gap:4px; cursor:pointer;">
        <span style="color:var(--green); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${val !== null ? esc(val) : '<span class="null-val">[NULL]</span>'}</span>
        <span style="color:var(--green); opacity:0.6; font-size:10px; flex-shrink:0;"><i class="ti ti-chevron-down" aria-hidden="true"></i></span>
      </div>
    `;
  }, 200);
}

export function renderPanel() {
  const p = document.getElementById('panel');
  if (!p) return;
  this.syncUrl();

  // Every branch below replaces the panel's innerHTML, which destroys any
  // CodeMirror instance living in it. Drop the reference so runQuery() never
  // reads a detached editor.
  // The SQL tab keeps its live editor between renders (renderSqlPanel re-uses it).
  if (this.S.tab !== 'sql') this.editor = null;

  if (this.S.tab === 'objects') {
    this.renderObjectsPanel();
    return;
  }

  if (!this.S.table && this.S.tab !== 'sql' && this.S.tab !== 'export' && this.S.tab !== 'import') {
    if (this.S.db) {
      p.innerHTML = `
        <div style="padding:48px 24px; text-align:center; max-width:640px; margin:0 auto;">
          <div style="width:52px; height:52px; margin:0 auto 16px; border-radius:50%; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center;">
            <i class="ti ti-database" aria-hidden="true" style="font-size:26px"></i>
          </div>
          <div style="font-family:var(--font-display); font-size:20px; font-weight:700; color:var(--text0); margin-bottom:8px;">
            Database: ${esc(this.S.db)}
          </div>
          <div style="color:var(--text2); font-size:13px; line-height:1.6; margin-bottom:24px;">
            Select a table from the sidebar to browse or modify its columns, or choose a database tool below:
          </div>
          <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">
            <button class="btn primary" onclick="window._dbm.showTab('export')"><i class="ti ti-download" aria-hidden="true"></i> Export Database</button>
            <button class="btn success" onclick="window._dbm.showTab('import')"><i class="ti ti-upload" aria-hidden="true"></i> Import Data</button>
            <button class="btn" onclick="window._dbm.showTab('sql')"><i class="ti ti-code" aria-hidden="true"></i> SQL Query</button>
          </div>
        </div>`;
    } else {
      p.innerHTML = '<div style="color:var(--text3); padding:32px; text-align:center;">Select a database from the sidebar to begin.</div>';
    }
    return;
  }

  const msgHtml = this.S.msg ? `<div class="result-msg ${this.S.msgType}">${this.S.msgType === 'success' ? '<i class="ti ti-circle-check" aria-hidden="true"></i>' : '<i class="ti ti-alert-circle" aria-hidden="true"></i>'} ${this.S.msg}</div>` : '';

  if (this.S.tab === 'browse') {
    const headers = this.APP.colHeaders[this.S.table] || [];
    const total = this.S.totalRows || 0;
    const perPage = parseInt(this.S.perPage, 10) || 25;
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    const pageRowsWithIndex = (this.APP.tableData[this.S.table] || []).map((row, i) => ({
      row,
      originalIndex: i
    }));

    const pageRowsIndices = pageRowsWithIndex.map(item => item.originalIndex);
    const allSelectedOnPage = pageRowsIndices.length > 0 && pageRowsIndices.every(idx => this.S.selected.has(idx));

    const startCount = total === 0 ? 0 : ((this.S.page || 1) - 1) * perPage + 1;
    const endCount = Math.min((this.S.page || 1) * perPage, total);

    const schema = this.APP.schemas[this.S.table] || [];
    const pkIndex = schema.findIndex(c => c.x === 'PK');

    const fkCols = this.APP.fkMeta?.[this.S.table] || {};

    // Pre-compute ENUM options
    const enumOptionsMap = {};
    schema.forEach(colDef => {
      const tLower = (colDef.t || '').toLowerCase();
      if (tLower.startsWith('enum')) {
        const match = colDef.t.match(/^enum\((.*)\)$/i);
        if (match) {
          const rawOptions = match[1];
          const opts = [];
          const regex = /'((?:''|[^'])*)'/g;
          let m;
          while ((m = regex.exec(rawOptions)) !== null) {
            opts.push(m[1].replace(/''/g, "'"));
          }
          enumOptionsMap[colDef.n] = opts;
        }
      }
    });

    const isLargeSet = pageRowsWithIndex.length > 50;

    let tbodyHtml = '';
    const chunkSize = 500;
    for (let i = 0; i < pageRowsWithIndex.length; i += chunkSize) {
      const slice = pageRowsWithIndex.slice(i, i + chunkSize);
      tbodyHtml += slice.map((item) => {
        const r = item.row;
        const actualRowIndex = item.originalIndex;
        const isSelected = this.S.selected.has(actualRowIndex);

        return `<tr data-row="${actualRowIndex}" class="${isSelected ? 'selected' : ''}">
              <td class="dg-check">
                <input type="checkbox" onchange="window._dbm.toggleRow(${actualRowIndex})" ${isSelected ? 'checked' : ''} style="cursor:pointer; accent-color:var(--accent);" />
              </td>
              ${r.map((c, cIdx) => {
          const isPk = cIdx === pkIndex;
          const colDef = schema[cIdx] || {};
          const tLower = (colDef.t || '').toLowerCase();
          const align = (tLower.includes('int') || tLower.includes('decimal') || tLower.includes('float') || tLower.includes('double')) ? 'right' : 'left';

          // Relationship (foreign key) cell
          if (fkCols[colDef.n]) {
            return this.renderFkCell(colDef.n, c, actualRowIndex, cIdx, 'left');
          }

          // ENUM Cell
          if (tLower.startsWith('enum') && enumOptionsMap[colDef.n]) {
            return `<td class="enum-cell-td" data-col="${cIdx}" style="text-align:${align};">
              <div class="fk-cell-view" onclick="window._dbm.activateEnumSelect(this, ${actualRowIndex}, ${cIdx})" title="Click to change">
                <span class="enum-cell-text">${c !== null ? esc(c) : '<span class="null-val">[NULL]</span>'}</span>
                <span class="fk-cell-arrow"><i class="ti ti-chevron-down" aria-hidden="true"></i></span>
              </div>
            </td>`;
          }

          // Standard Cell
          return `<td data-col="${cIdx}" style="text-align:${align};" ${c === null ? 'data-null="1" ' : ''}${!isPk ? `ondblclick="window._dbm.onCellDblClick(this)" title="Double-click to edit"` : `data-pk="1" style="opacity:0.6; cursor:not-allowed;" title="Primary Key"`}>${c !== null ? esc(c) : '<span class="null-val">NULL</span>'}</td>`;
        }).join('')}
            </tr>`;
      }).join('');
    }

    // Filter bar when open, otherwise a row of chips for whatever is active.
    const builderHtml = this.S.showBuilder ? this.renderFilterBar(headers) : this.renderFilterChips();

    const activeFilterCount = Object.keys(this.S.colFilters || {}).length;

    // The filter bar is re-drawn with the grid; remember where the cursor was.
    const fa = document.activeElement;
    const fbFocus = fa && fa.dataset && fa.dataset.fkey && p.contains(fa)
      ? { key: fa.dataset.fkey, start: fa.selectionStart, end: fa.selectionEnd } : null;

    p.innerHTML = `${msgHtml}
          <div class="table-top-bar">
              <div class="table-top-left">
                  <div class="section-title" style="margin:0;">Data <span class="badge">${esc(this.S.table)}</span></div>
                  <div class="table-top-divider"></div>
                  <button class="btn primary" onclick="window._dbm.openInsertRowModal()"><i class="ti ti-plus" aria-hidden="true"></i> Insert Row</button>
                  <button class="btn" onclick="window._dbm.copySelected()" ${this.S.selected.size === 0 ? 'disabled' : ''}><i class="ti ti-copy" aria-hidden="true"></i> Duplicate (${this.S.selected.size})</button>
                  <button class="btn danger" onclick="window._dbm.deleteSelected()" ${this.S.selected.size === 0 ? 'disabled' : ''}><i class="ti ti-trash" aria-hidden="true"></i> Delete (${this.S.selected.size})</button>
              </div>
              <div class="table-top-right">
                  <button class="btn" onclick="window._dbm.showTab('export')" title="Export Table Data">
                     <i class="ti ti-download" aria-hidden="true" style="font-size:12px; margin-right:4px"></i>
                     Export
                  </button>
                  <button class="btn" onclick="window._dbm.showTab('import')" title="Import Data into Table">
                     <i class="ti ti-upload" aria-hidden="true" style="font-size:12px; margin-right:4px"></i>
                     Import
                  </button>
                  <button class="btn ${this.S.showFilterRow ? 'primary' : ''}" onclick="window._dbm.toggleFilterRow()" title="Toggle Quick Column Filter Row">
                     <i class="ti ti-filter" aria-hidden="true" style="font-size:12px; margin-right:4px"></i>
                     Filter Row ${activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
                  </button>

                  <button class="btn ${this.S.showBuilder ? 'primary' : ''}" onclick="window._dbm.toggleQueryBuilder()" title="Filter and sort rows (or right-click a cell)">
                     <i class="ti ti-adjustments-horizontal" aria-hidden="true" style="font-size:12px; margin-right:4px"></i>
                     Filter &amp; Sort ${this.filterBarCount() ? `(${this.filterBarCount()})` : ''}
                  </button>
              </div>
          </div>
  
          ${builderHtml}
  
          <div class="tbl-wrapper">
              <table class="data-tbl dgrid dgrid-bordered">
                  <thead>
                    <tr>
                      <th class="dg-check">
                        <input type="checkbox" onchange="window._dbm.toggleAll(this.checked)" ${allSelectedOnPage ? 'checked' : ''} style="cursor:pointer; accent-color:var(--accent);" title="Select all rows" />
                      </th>
                      ${headers.map(h => {
                        const activeSort = (this.S.sorts || []).find(s => s.col === h);
                        const sortIcon = activeSort ? (activeSort.dir === 'asc' ? '<i class="ti ti-arrow-up" aria-hidden="true"></i>' : '<i class="ti ti-arrow-down" aria-hidden="true"></i>') : '<i class="ti ti-arrows-sort" aria-hidden="true"></i>';
                        const isSorted = !!activeSort;
                        return `
                          <th style="position:relative;" onclick="window._dbm.toggleSortByCol('${escJs(h)}')" oncontextmenu="window._dbm.onGridHeaderContextMenu(event, '${escJs(h)}')">
                            <div class="th-content">
                              <span class="th-title" title="Click to sort by ${esc(h)}">${esc(h)}</span>${this.fkHeaderBadge(h)}
                              <span class="th-sort-icon ${isSorted ? 'active' : ''}">${sortIcon}</span>
                            </div>
                            <div class="col-resizer" onmousedown="window._dbm.initResize(event, this)"></div>
                          </th>
                        `;
                      }).join('')}
                    </tr>
                    ${this.S.showFilterRow ? `
                      <tr class="filter-row">
                        <td class="filter-cell filter-cell-action" style="text-align:center;">
                          ${activeFilterCount > 0 ? `
                            <button class="btn-clear-filter" onclick="window._dbm.clearAllColumnFilters()" title="Clear all column filters"><i class="ti ti-x" aria-hidden="true"></i></button>
                          ` : ''}
                        </td>
                        ${headers.map(h => {
                          const fv = this.S.colFilters?.[h] || '';
                          // Relationship columns: match by ID or name, with a picker.
                          if (fkCols[h]) return `<td class="filter-cell">${this.renderFkFilterCell(h)}</td>`;
                          // ENUM columns: choose one of the allowed values.
                          const enumOpts = enumOptionsMap[h];
                          if (enumOpts) {
                            const colDef = schema.find(s => s.n === h) || {};
                            return `
                          <td class="filter-cell">
                            <div class="col-filter-box">
                              <select class="col-filter-inp col-filter-select" id="col-filter-${esc(h)}" aria-label="Filter ${esc(h)}"
                                      onchange="window._dbm.setColumnFilter('${escJs(h)}', this.value); window._dbm.applyColumnFilters();">
                                <option value="" ${fv === '' ? 'selected' : ''}>All</option>
                                ${enumOpts.map(o => `<option value="=${esc(o)}" ${fv === `=${o}` ? 'selected' : ''}>${esc(o)}</option>`).join('')}
                                ${colDef.null ? `<option value="NULL" ${fv.toUpperCase() === 'NULL' ? 'selected' : ''}>NULL</option>` : ''}
                              </select>
                            </div>
                          </td>`;
                          }
                          return `
                          <td class="filter-cell">
                            <div class="col-filter-box">
                              <input class="col-filter-inp"
                                     id="col-filter-${esc(h)}"
                                     value="${esc(fv)}"
                                     placeholder="= ${esc(h)}…"
                                     title="Exact match (=). Prefix with !=, >, <, >=, <=, or 'like'. NULL finds empty values, !NULL non-empty."
                                     onkeydown="if(event.key === 'Enter') { window._dbm.applyColumnFilters(); }"
                                     oninput="window._dbm.setColumnFilter('${escJs(h)}', this.value)" />
                              ${fv ? `
                                <button class="col-filter-clear-btn" onclick="window._dbm.clearSingleColumnFilter('${escJs(h)}')"><i class="ti ti-x" aria-hidden="true"></i></button>
                              ` : ''}
                            </div>
                          </td>`;
                        }).join('')}
                      </tr>
                    ` : ''}
                  </thead>
                  <tbody oncontextmenu="window._dbm.onGridCellContextMenu(event)">${tbodyHtml || `<tr><td colspan="${headers.length + 1}" style="text-align:center;padding:32px;color:var(--text3)">No data found</td></tr>`}</tbody>
              </table>
          </div>

          <div class="table-footer-bar">
              <div class="footer-left">
                  <span class="footer-rows-info">
                    Showing <strong>${startCount.toLocaleString()}</strong> to <strong>${endCount.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> rows
                  </span>
                  <div class="footer-export-group">
                      <button class="btn btn-sm success" onclick="window._dbm.exportSelected('csv')" title="Export table data to CSV"><i class="ti ti-file-type-csv" aria-hidden="true"></i> Export CSV</button>
                      <button class="btn btn-sm amber" onclick="window._dbm.exportSelected('json')" title="Export table data to JSON"><i class="ti ti-braces" aria-hidden="true"></i> Export JSON</button>
                      <button class="btn btn-sm" onclick="window._dbm.showTab('export')" title="Open Export Tab"><i class="ti ti-download" aria-hidden="true"></i> Export...</button>
                      <button class="btn btn-sm primary" onclick="window._dbm.showTab('import')" title="Import data into this table"><i class="ti ti-upload" aria-hidden="true"></i> Import...</button>
                  </div>
              </div>
              <div class="footer-pagination">
                  <select class="search-input per-page-select" style="min-width:105px; width:auto; padding:4px 8px;" onchange="window._dbm.setPerPage(this.value)">
                      ${[25, 50, 100, 250, 500, 1000].map(n => `<option value="${n}" ${perPage === n ? 'selected' : ''}>${n} / page</option>`).join('')}
                  </select>
                  <button class="btn btn-sm" onclick="window._dbm.changePage(-1)" ${this.S.page <= 1 ? 'disabled' : ''} title="Previous Page"><i class="ti ti-chevron-left" aria-hidden="true"></i> Prev</button>
                  <span class="footer-page-badge">Page ${this.S.page} of ${totalPages}</span>
                  <button class="btn btn-sm" onclick="window._dbm.changePage(1)" ${this.S.page >= totalPages ? 'disabled' : ''} title="Next Page">Next <i class="ti ti-chevron-right" aria-hidden="true"></i></button>
              </div>
          </div>`;
    this.restoreFilterFocus(fbFocus);
  }
  else if (this.S.tab === 'structure') {
    this.renderStructurePanel(p, msgHtml);
  }
  else if (this.S.tab === 'sql') {
    this.renderSqlPanel(p, msgHtml);
  }
  else if (this.S.tab === 'export') {
    this.renderExportPanel();
  }
  else if (this.S.tab === 'import') {
    this.renderImportPanel();
  }
}

export function renderExportPanel() {
  const p = document.getElementById('panel');
  if (!p) return;

  if (!this.S.db) {
    p.innerHTML = `<div class="ei-container"><div style="text-align:center; padding:60px 20px; color:var(--text2);">Please select a database from the sidebar to export.</div></div>`;
    return;
  }

  // Table sizes/rows: also load them when the page opens straight on this tab
  // (reload, or a link opened in a new browser tab), once per database.
  if (this.S.db && this.S.exportInfoTried !== this.S.db && this.S.exportInfoDb !== this.S.db) {
    this.S.exportInfoTried = this.S.db;
    this.loadExportTablesInfo();
  }

  const isTableScope = this.S.exportScope === 'table' && this.S.table;
  const currentFormat = this.S.exportFormat || 'sql';
  const currentType = this.S.exportType || 'all';
  const dbTables = this.APP.databases[this.S.db]?.tables || [];

  const tablesInfo = (this.S.exportTablesInfo && this.S.exportTablesInfo.length > 0)
    ? this.S.exportTablesInfo
    : dbTables.map(t => ({ name: t, rows: 0, size: 0, engine: 'InnoDB' }));

  const filter = (this.S.exportSearchFilter || '').toLowerCase().trim();
  const filteredTables = tablesInfo.filter(t => !filter || t.name.toLowerCase().includes(filter));
  const selectedCount = this.S.exportTables ? this.S.exportTables.size : 0;

  // Sizes: what MySQL reports on disk (data + indexes) and its row estimates.
  const sumOf = (list) => list.reduce((a, t) => ({ size: a.size + (Number(t.size) || 0), rows: a.rows + (Number(t.rows) || 0) }), { size: 0, rows: 0 });
  const dbTotal = sumOf(tablesInfo);
  const sizesKnown = dbTotal.size > 0;
  const selTotal = isTableScope
    ? sumOf(tablesInfo.filter(t => t.name === this.S.table))
    : sumOf(tablesInfo.filter(t => this.S.exportTables && this.S.exportTables.has(t.name)));
  const viewCount = tablesInfo.filter(t => /view/i.test(t.engine || '')).length;
  // "68 tables · 5 views": tables and views are counted apart everywhere on this page.
  const isViewInfo = (t) => /view/i.test(t.engine || '');
  const selViews = tablesInfo.filter(t => isViewInfo(t) && this.S.exportTables && this.S.exportTables.has(t.name)).length;
  const selBase = selectedCount - selViews;
  const countLabel = (nT, nV) => [
    `${nT.toLocaleString()} ${nT === 1 ? 'table' : 'tables'}`,
    nV ? `${nV.toLocaleString()} ${nV === 1 ? 'view' : 'views'}` : ''
  ].filter(Boolean).join(' · ');
  const sizeTitle = 'Size on disk (data + indexes) as reported by MySQL. The exported file is usually a similar size.';

  let html = `
    <div class="ei-container">
      <div class="ei-header">
        <div class="ei-title-group">
          <div style="width:36px; height:36px; border-radius:8px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center;">
            <i class="ti ti-download" aria-hidden="true" style="font-size:20px"></i>
          </div>
          <div>
            <div class="ei-title">Export Database & Tables</div>
            <div style="font-size:12px; color:var(--text2);">
              Export ${isTableScope ? `table <strong style="color:var(--text0);">${esc(this.S.table)}</strong>` : `database <strong style="color:var(--text0);">${esc(this.S.db)}</strong>`} to your computer
            </div>
            ${sizesKnown ? `
            <div class="ei-db-size" title="${sizeTitle}">
              <span><i class="ti ti-database" aria-hidden="true"></i> ${esc(this.S.db)}</span>
              <span><strong>${formatBytes(dbTotal.size)}</strong> total</span>
              <span><strong>${(tablesInfo.length - viewCount).toLocaleString()}</strong> tables${viewCount ? ` · <strong>${viewCount}</strong> views` : ''}</span>
              <span>≈ <strong>${dbTotal.rows.toLocaleString()}</strong> rows</span>
            </div>` : ''}
          </div>
        </div>

        ${this.S.table ? `
        <div class="ei-scope-pill">
          <button class="ei-scope-btn ${!isTableScope ? 'active' : ''}" onclick="window._dbm.setExportScope('database')">
            <i class="ti ti-database" aria-hidden="true"></i> Database (${esc(this.S.db)})
          </button>
          <button class="ei-scope-btn ${isTableScope ? 'active' : ''}" onclick="window._dbm.setExportScope('table')">
            <i class="ti ti-table" aria-hidden="true"></i> Table (${esc(this.S.table)})
          </button>
        </div>` : ''}
      </div>

      <!-- Format Selection -->
      <div class="ei-card">
        <div class="ei-card-title">
          <i class="ti ti-layout-grid" aria-hidden="true" style="font-size:15px"></i>
          1. Select Format
        </div>
        <div class="ei-format-grid">
          <div class="ei-format-card ${currentFormat === 'sql' ? 'active' : ''}" onclick="window._dbm.setExportFormat('sql')">
            <div class="ei-format-icon"><i class="ti ti-file-type-sql" aria-hidden="true"></i></div>
            <div class="ei-format-name">SQL</div>
            <div class="ei-format-desc">Complete dump with CREATE & INSERT</div>
          </div>
          <div class="ei-format-card ${currentFormat === 'csv' ? 'active' : ''}" onclick="window._dbm.setExportFormat('csv')">
            <div class="ei-format-icon"><i class="ti ti-file-type-csv" aria-hidden="true"></i></div>
            <div class="ei-format-name">CSV</div>
            <div class="ei-format-desc">Spreadsheet data with column headers</div>
          </div>
          <div class="ei-format-card ${currentFormat === 'json' ? 'active' : ''}" onclick="window._dbm.setExportFormat('json')">
            <div class="ei-format-icon"><i class="ti ti-braces" aria-hidden="true"></i></div>
            <div class="ei-format-name">JSON</div>
            <div class="ei-format-desc">Structured records document</div>
          </div>
        </div>
      </div>

      <!-- Format Options -->
      <div class="ei-card">
        <div class="ei-card-title">
          <i class="ti ti-settings" aria-hidden="true" style="font-size:15px"></i>
          2. Export Options
        </div>

        ${currentFormat === 'sql' ? `
        <div style="margin-bottom:14px;">
          <div style="font-size:11px; text-transform:uppercase; color:var(--text2); letter-spacing:0.8px; margin-bottom:8px;">Dump Content</div>
          <div style="display:flex; gap:16px; flex-wrap:wrap;">
            <label class="ei-checkbox-label">
              <input type="radio" name="export-type-radio" value="all" ${currentType === 'all' ? 'checked' : ''} onchange="window._dbm.setExportType(this.value)">
              <span>Structure and data</span>
            </label>
            <label class="ei-checkbox-label">
              <input type="radio" name="export-type-radio" value="structure" ${currentType === 'structure' ? 'checked' : ''} onchange="window._dbm.setExportType(this.value)">
              <span>Structure only</span>
            </label>
            <label class="ei-checkbox-label">
              <input type="radio" name="export-type-radio" value="data" ${currentType === 'data' ? 'checked' : ''} onchange="window._dbm.setExportType(this.value)">
              <span>Data only</span>
            </label>
          </div>
        </div>

        <div class="ei-checkbox-group">
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.exportDropTable ? 'checked' : ''} onchange="window._dbm.toggleExportOption('dropTable')">
            <span>Add <code>DROP TABLE IF EXISTS</code> statement</span>
          </label>
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.exportDisableFk ? 'checked' : ''} onchange="window._dbm.toggleExportOption('disableFk')">
            <span>Disable foreign key checks during import (<code>SET FOREIGN_KEY_CHECKS = 0</code>)</span>
          </label>
          ${!isTableScope ? `
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.exportCreateDb ? 'checked' : ''} onchange="window._dbm.toggleExportOption('createDb')">
            <span>Add <code>CREATE DATABASE IF NOT EXISTS</code> statement</span>
          </label>` : ''}
          ${currentType !== 'data' ? `
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.exportRoutines ? 'checked' : ''} onchange="window._dbm.toggleExportOption('routines')">
            <span>${isTableScope ? 'Include triggers' : 'Include triggers, stored procedures, functions &amp; events'}</span>
          </label>
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.exportKeepDefiner ? 'checked' : ''} onchange="window._dbm.toggleExportOption('keepDefiner')">
            <span>Keep <code>DEFINER</code> clauses (leave off to import on another server or as another user)</span>
          </label>` : ''}
        </div>` : ''}

        <label class="ei-checkbox-label ei-gzip-option">
          <input type="checkbox" ${this.S.exportGzip ? 'checked' : ''} onchange="window._dbm.toggleExportOption('gzip')">
          <span><i class="ti ti-file-zip" aria-hidden="true"></i> <strong>Compress (gzip)</strong>: download <code>.${currentFormat}.gz</code>, usually 5–10× smaller.
            Import accepts it as is; Windows 11 and 7-Zip can open it.</span>
        </label>

        ${currentFormat === 'csv' ? `
        <div style="font-size:12px; color:var(--text1); line-height:1.6;">
          • Formatted with UTF-8 BOM encoding for complete Unicode, Khmer, and Excel compatibility.<br>
          • Uses standard comma (<code>,</code>) delimiter and escapes special characters.<br>
          • Includes column header row automatically.
        </div>` : ''}

        ${currentFormat === 'json' ? `
        <div style="font-size:12px; color:var(--text1); line-height:1.6;">
          • Formats rows into clean, readable JSON records.<br>
          • Safe for use in REST APIs, NoSQL pipelines, backups, and migration.
        </div>` : ''}
      </div>

      <!-- Table Selection (Database Scope Only) -->
      ${!isTableScope ? `
      <div class="ei-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
          <div class="ei-card-title" style="margin-bottom:0;">
            <i class="ti ti-list-check" aria-hidden="true" style="font-size:15px"></i>
            3. ${viewCount ? 'Tables &amp; Views' : 'Tables'} to Export
            <span class="ei-sel-count" id="ei-sel-count" title="${countLabel(selBase, selViews)} selected, out of ${countLabel(tablesInfo.length - viewCount, viewCount)}">${selectedCount} / ${tablesInfo.length}</span>
            ${sizesKnown ? `<span class="ei-sel-size" title="${sizeTitle}">${formatBytes(selTotal.size)} of ${formatBytes(dbTotal.size)}</span>` : ''}
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input class="search-input" style="padding:4px 8px; font-size:11px; width:160px;" placeholder="Filter tables…" value="${esc(this.S.exportSearchFilter || '')}" oninput="window._dbm.onExportSearch(this.value)">
            <button class="btn btn-sm" onclick="window._dbm.toggleAllExportTables(true)">Select All</button>
            <button class="btn btn-sm" onclick="window._dbm.toggleAllExportTables(false)">Deselect All</button>
          </div>
        </div>

        <!-- Same table component as Objects / Browse / Structure. Click a row to tick it. -->
        <div class="tbl-wrapper ei-table-grid" id="ei-table-picker-list">
          <table class="dgrid dgrid-bordered obj-grid">
            <thead>
              <tr>
                <th class="dg-check"><input type="checkbox" aria-label="Select all tables" ${tablesInfo.length && selectedCount === tablesInfo.length ? 'checked' : ''}
                    onclick="event.stopPropagation()" onchange="window._dbm.toggleAllExportTables(this.checked)"></th>
                <th>Name</th>
                <th>Type</th>
                <th class="num">Rows</th>
                <th class="num" title="${sizeTitle}">Size</th>
              </tr>
            </thead>
            <tbody>
              ${filteredTables.length === 0 ? `<tr><td colspan="5" class="obj-msg-cell">No tables found</td></tr>` : ''}
              ${filteredTables.map(t => {
                const isChecked = this.S.exportTables ? this.S.exportTables.has(t.name) : true;
                const isView = /view/i.test(t.engine || '');
                return `
                  <tr class="ei-table-row ${isChecked ? 'selected' : ''}" data-table="${esc(t.name)}" onclick="window._dbm.toggleExportTable('${escJs(t.name)}')">
                    <td class="dg-check"><input type="checkbox" aria-label="Export ${esc(t.name)}" ${isChecked ? 'checked' : ''}
                        onclick="event.stopPropagation()" onchange="window._dbm.toggleExportTable('${escJs(t.name)}')"></td>
                    <td><span class="obj-name ${isView ? 'is-view' : ''}"><i class="ti ${isView ? 'ti-eye' : 'ti-table'} tbl-icon" aria-hidden="true"></i><span>${esc(t.name)}</span></span></td>
                    <td>${isView ? '<span class="obj-view-tag">VIEW</span>' : `<span class="obj-dim">${esc(t.engine || 'InnoDB')}</span>`}</td>
                    <td class="num">${isView ? '' : (Number(t.rows) || 0).toLocaleString()}</td>
                    <td class="num">${isView ? '' : formatBytes(t.size || 0)}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

      <!-- Action Bar -->
      <div class="ei-action-bar">
        ${sizesKnown ? `
        <div class="ei-export-summary" title="${sizeTitle}">
          Exporting <strong>${isTableScope ? esc(this.S.table) : countLabel(selBase, selViews)}</strong>
          · <strong>${formatBytes(selTotal.size)}</strong> · ≈ ${selTotal.rows.toLocaleString()} rows${this.S.exportGzip ? ` · <span class="ei-gz-note"><i class="ti ti-file-zip" aria-hidden="true"></i> compressed .gz</span>` : ''}
          ${selTotal.size > 20 * 1048576 ? `<span class="ei-summary-hint">Too big to preview, so use Download</span>` : ''}
        </div>` : ''}
        <button class="btn" onclick="window._dbm.executeExport(false)" ${this.S.exportLoading ? 'disabled' : ''}>
          <i class="ti ti-eye" aria-hidden="true"></i> Preview / Copy
        </button>
        <button class="btn primary" onclick="window._dbm.executeExport(true)" ${this.S.exportLoading ? 'disabled' : ''} style="min-width:180px;">
          ${this.S.exportLoading ? '<span class="spinner"></span> Exporting...' : '<i class="ti ti-download" aria-hidden="true"></i> Download Export File'}
        </button>
      </div>
    </div>
  `;

  p.innerHTML = html;
}

export function renderImportPanel() {
  const p = document.getElementById('panel');
  if (!p) return;

  if (!this.S.db) {
    p.innerHTML = `<div class="ei-container"><div style="text-align:center; padding:60px 20px; color:var(--text2);">Please select a database from the sidebar to import.</div></div>`;
    return;
  }

  const dbTables = this.APP.databases[this.S.db]?.tables || [];
  const currentFormat = this.S.importFormat || 'auto';
  const currentMode = this.S.importMode || 'insert';
  const targetTable = this.S.importTargetTable || this.S.table || (dbTables[0] || '');
  const file = this.S.importFile;
  const result = this.S.importResult;
  const preview = this.S.importPreviewData;

  let html = `
    <div class="ei-container">
      <div class="ei-header">
        <div class="ei-title-group">
          <div style="width:36px; height:36px; border-radius:8px; background:var(--green-dim); color:var(--green); display:flex; align-items:center; justify-content:center;">
            <i class="ti ti-upload" aria-hidden="true" style="font-size:20px"></i>
          </div>
          <div>
            <div class="ei-title">Import Data</div>
            <div style="font-size:12px; color:var(--text2);">
              Target Database: <strong style="color:var(--accent);">${esc(this.S.db)}</strong>
            </div>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:11px; color:var(--text2); text-transform:uppercase; font-weight:600;">Target Table:</span>
          <select class="search-input" style="padding:4px 8px; font-size:12px; min-width:140px;" onchange="window._dbm.setImportTargetTable(this.value)">
            <option value="">-- Auto / Whole DB --</option>
            ${dbTables.map(t => `<option value="${esc(t)}" ${targetTable === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- Execution Result Banner (if exists) -->
      ${result ? `
      <div style="padding:16px 20px; border-radius:var(--radius-lg); ${result.success ? 'background:rgba(62, 207, 142, 0.12); border:1px solid rgba(62, 207, 142, 0.35);' : 'background:rgba(240, 82, 82, 0.12); border:1px solid rgba(240, 82, 82, 0.35);'}">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <div style="font-weight:700; font-size:14px; color:${result.success ? 'var(--green)' : 'var(--red)'}; display:flex; align-items:center; gap:8px;">
            ${result.success ? '<i class="ti ti-circle-check" aria-hidden="true"></i> Import Completed Successfully!' : '<i class="ti ti-alert-triangle" aria-hidden="true"></i> Import Finished with Errors'}
          </div>
          <button class="btn btn-sm" onclick="window._dbm.refreshSidebar(); if(window._dbm.S.table) window._dbm.loadTableDataFromServer(window._dbm.S.db, window._dbm.S.table); window._dbm.showTab('browse');">
            <i class="ti ti-table" aria-hidden="true"></i> View Data in Table
          </button>
        </div>
        <div style="font-size:12px; color:var(--text0); font-family:var(--font-mono); line-height:1.6;">
          ${result.format === 'sql' 
            ? `Queries executed: <strong>${result.queries_executed || 0}</strong> / ${result.queries_total || 0} | Affected rows: <strong>${result.rows_affected || 0}</strong> | Duration: <strong>${result.time_ms || 0} ms</strong>` 
            : `Rows imported: <strong>${result.rows_imported || 0}</strong> | Duration: <strong>${result.time_ms || 0} ms</strong>`}
        </div>
        ${result.errors && result.errors.length > 0 ? `
        <div style="margin-top:10px; max-height:160px; overflow-y:auto; background:var(--bg0); border-radius:var(--radius); padding:10px; font-size:11px; font-family:var(--font-mono);">
          ${result.errors.map(err => `<div style="color:var(--red); margin-bottom:4px;">• Query #${err.query_index}: ${esc(err.error)} <div style="color:var(--text2); font-size:10px;">${esc(err.snippet || '')}</div></div>`).join('')}
        </div>` : ''}
      </div>` : ''}

      <!-- Upload Zone Card -->
      <div class="ei-card">
        <div class="ei-card-title">
          <i class="ti ti-file-text" aria-hidden="true" style="font-size:15px"></i>
          1. Upload File or Paste SQL
        </div>

        <input type="file" id="import-file-input" style="display:none;" accept=".sql,.csv,.json,.txt,.gz" onchange="window._dbm.handleImportFileSelect(event)">

        <div class="ei-dropzone" id="ei-dropzone-box"
             onclick="document.getElementById('import-file-input').click()"
             ondragover="window._dbm.handleImportDragOver(event)"
             ondragleave="window._dbm.handleImportDragLeave(event)"
             ondrop="window._dbm.handleImportDrop(event)">
          <div class="ei-dropzone-icon">
            <i class="ti ti-cloud-upload" aria-hidden="true" style="font-size:36px"></i>
          </div>
          <div class="ei-dropzone-title">Click to select file or drag & drop here</div>
          <div class="ei-dropzone-sub">Supports <strong>.sql</strong> (dump script), <strong>.csv</strong> (table data), or <strong>.json</strong> (records), also compressed as <strong>.gz</strong></div>
        </div>

        ${file ? `
        <div class="ei-file-chip">
          <div class="ei-file-info">
            <span style="font-size:20px; color:var(--accent);"><i class="ti ti-file" aria-hidden="true"></i></span>
            <div>
              <div class="ei-file-name">${esc(file.name)}</div>
              <div class="ei-file-size">${formatBytes(file.size)} • Type: ${esc(currentFormat.toUpperCase())}</div>
            </div>
          </div>
          <button class="btn btn-sm danger" onclick="window._dbm.removeImportFile(); event.stopPropagation();"><i class="ti ti-x" aria-hidden="true"></i> Remove</button>
        </div>` : ''}

        <details style="margin-top:14px; border-top:1px solid var(--line); padding-top:12px;" ${this.S.importRawData ? 'open' : ''}>
          <summary style="cursor:pointer; font-size:11px; font-weight:600; color:var(--text1); text-transform:uppercase;">
            Or Paste Raw SQL / Data Directly
          </summary>
          <textarea class="search-input" style="width:100%; height:110px; margin-top:8px; font-family:var(--font-mono); font-size:11px; padding:8px;" placeholder="Paste raw SQL statements or CSV data here…" oninput="window._dbm.onImportRawDataInput(this.value)">${esc(this.S.importRawData || '')}</textarea>
        </details>
      </div>

      <!-- Format and Options Card -->
      <div class="ei-card">
        <div class="ei-card-title">
          <i class="ti ti-settings" aria-hidden="true" style="font-size:15px"></i>
          2. Format & Settings
        </div>

        <div class="ei-format-grid" style="margin-bottom:16px;">
          <div class="ei-format-card ${currentFormat === 'auto' ? 'active' : ''}" onclick="window._dbm.setImportFormat('auto')">
            <div class="ei-format-icon"><i class="ti ti-wand" aria-hidden="true"></i></div>
            <div class="ei-format-name">Auto-detect</div>
            <div class="ei-format-desc">From file extension</div>
          </div>
          <div class="ei-format-card ${currentFormat === 'sql' ? 'active' : ''}" onclick="window._dbm.setImportFormat('sql')">
            <div class="ei-format-icon"><i class="ti ti-file-type-sql" aria-hidden="true"></i></div>
            <div class="ei-format-name">SQL</div>
            <div class="ei-format-desc">Run queries / dump</div>
          </div>
          <div class="ei-format-card ${currentFormat === 'csv' ? 'active' : ''}" onclick="window._dbm.setImportFormat('csv')">
            <div class="ei-format-icon"><i class="ti ti-file-type-csv" aria-hidden="true"></i></div>
            <div class="ei-format-name">CSV</div>
            <div class="ei-format-desc">Import into table</div>
          </div>
          <div class="ei-format-card ${currentFormat === 'json' ? 'active' : ''}" onclick="window._dbm.setImportFormat('json')">
            <div class="ei-format-icon"><i class="ti ti-braces" aria-hidden="true"></i></div>
            <div class="ei-format-name">JSON</div>
            <div class="ei-format-desc">Import records</div>
          </div>
        </div>

        <!-- Conditional options -->
        ${(currentFormat === 'sql' || currentFormat === 'auto') ? `
        <div class="ei-checkbox-group" style="margin-bottom:12px;">
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.importDisableFk ? 'checked' : ''} onchange="window._dbm.toggleImportOption('disableFk')">
            <span>Disable foreign key checks during import (<code>SET FOREIGN_KEY_CHECKS = 0</code>)</span>
          </label>
          <label class="ei-checkbox-label">
            <input type="checkbox" ${this.S.importContinueOnError ? 'checked' : ''} onchange="window._dbm.toggleImportOption('continueOnError')">
            <span>Continue on error (skip failing statements and execute remaining queries)</span>
          </label>
        </div>` : ''}

        ${(currentFormat === 'csv' || currentFormat === 'json') ? `
        <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:12px;">
          <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center;">
            ${currentFormat === 'csv' ? `
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:11px; text-transform:uppercase; color:var(--text2); font-weight:600;">Delimiter:</span>
              <select class="search-input" style="padding:4px 8px; font-size:12px;" onchange="window._dbm.setImportDelimiter(this.value)">
                <option value="," ${this.S.importCsvDelimiter === ',' ? 'selected' : ''}>Comma (,)</option>
                <option value=";" ${this.S.importCsvDelimiter === ';' ? 'selected' : ''}>Semicolon (;)</option>
                <option value="\t" ${this.S.importCsvDelimiter === '\t' ? 'selected' : ''}>Tab (\\t)</option>
                <option value="|" ${this.S.importCsvDelimiter === '|' ? 'selected' : ''}>Pipe (|)</option>
              </select>
            </div>
            <label class="ei-checkbox-label">
              <input type="checkbox" ${this.S.importCsvHasHeaders ? 'checked' : ''} onchange="window._dbm.toggleImportOption('csvHeaders')">
              <span>First row contains column headers</span>
            </label>` : ''}
          </div>

          <div>
            <div style="font-size:11px; text-transform:uppercase; color:var(--text2); letter-spacing:0.8px; margin-bottom:6px;">Import Mode</div>
            <div style="display:flex; gap:14px; flex-wrap:wrap;">
              <label class="ei-checkbox-label">
                <input type="radio" name="import-mode-radio" value="insert" ${currentMode === 'insert' ? 'checked' : ''} onchange="window._dbm.setImportMode(this.value)">
                <span>Append / Insert (<code>INSERT INTO</code>)</span>
              </label>
              <label class="ei-checkbox-label">
                <input type="radio" name="import-mode-radio" value="replace" ${currentMode === 'replace' ? 'checked' : ''} onchange="window._dbm.setImportMode(this.value)">
                <span>Replace matching keys (<code>REPLACE INTO</code>)</span>
              </label>
              <label class="ei-checkbox-label">
                <input type="radio" name="import-mode-radio" value="truncate_insert" ${currentMode === 'truncate_insert' ? 'checked' : ''} onchange="window._dbm.setImportMode(this.value)">
                <span>Empty table first (<code>TRUNCATE & INSERT</code>)</span>
              </label>
            </div>
          </div>
        </div>` : ''}
      </div>

      <!-- Preview Box (if available) -->
      ${preview ? `
      <div class="ei-card">
        <div class="ei-card-title">
          <i class="ti ti-eye" aria-hidden="true" style="font-size:15px"></i>
          3. Data Preview (${esc(preview.format?.toUpperCase())})
        </div>

        ${preview.format === 'sql' ? `
        <div style="margin-bottom:8px; font-size:12px; color:var(--text1);">
          Detected <strong>${preview.total_queries || 0}</strong> SQL statements. Showing first ${preview.preview?.length || 0}:
        </div>
        <div class="ei-preview-box">
          <pre class="ei-preview-code">${esc((preview.preview || []).join(';\n\n'))}</pre>
        </div>` : ''}

        ${preview.format === 'csv' ? `
        <div style="margin-bottom:8px; font-size:12px; color:var(--text1);">
          Detected delimiter: <code>${esc(preview.detected_delimiter || ',')}</code> • Total rows: ~<strong>${preview.total_rows || 0}</strong>
        </div>
        <div class="ei-preview-box">
          <table class="ei-preview-table">
            <thead>
              <tr>${(preview.headers || []).map(h => `<th>${esc(h)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${(preview.preview_rows || []).map(row => `<tr>${(row || []).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}

        ${preview.format === 'json' ? `
        <div style="margin-bottom:8px; font-size:12px; color:var(--text1);">
          Total JSON items: <strong>${preview.total_items || 0}</strong>
        </div>
        <div class="ei-preview-box">
          <pre class="ei-preview-code">${esc(JSON.stringify(preview.preview || [], null, 2))}</pre>
        </div>` : ''}
      </div>` : ''}

      <!-- Action Bar -->
      <div class="ei-action-bar">
        ${(file || this.S.importRawData) && !preview ? `
        <button class="btn" onclick="window._dbm.previewImport()">
          <i class="ti ti-search" aria-hidden="true"></i> Preview Data
        </button>` : ''}
        <button class="btn" onclick="window._dbm.resetImport()">
          <i class="ti ti-restore" aria-hidden="true"></i> Reset
        </button>
        <button class="btn success" onclick="window._dbm.executeImport()" ${this.S.importLoading || (!file && !this.S.importRawData.trim()) ? 'disabled' : ''} style="min-width:180px;">
          ${this.S.importLoading ? '<span class="spinner"></span> Importing Data...' : '<i class="ti ti-upload" aria-hidden="true"></i> Start Import'}
        </button>
      </div>
    </div>
  `;

  p.innerHTML = html;
}
