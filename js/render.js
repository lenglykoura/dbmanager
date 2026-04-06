/**
 * Displays a custom styled alert dialog
 * @param {string} title - The header text
 * @param {string} msg - The body message
 * @param {string} type - 'error' or 'success'
 */

export function showAlertDialog(title, msg, type = 'success') {
  const color = type === 'error' ? 'var(--red)' : 'var(--green)';
  const icon = type === 'error' ? '✕' : '✓';

  const modalHtml = `
        <div id="custom-alert-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:10000; backdrop-filter:blur(4px); animation: fadeIn 0.2s ease;">
            <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); padding:28px; width:400px; box-shadow:0 32px 64px rgba(0,0,0,0.5); text-align:center;">
                <div style="width:50px; height:50px; border-radius:50%; background:${color}20; color:${color}; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:24px; font-weight:bold; border:2px solid ${color}40;">
                    ${icon}
                </div>
                <div style="font-family:var(--font-display); font-size:18px; font-weight:700; color:var(--text0); margin-bottom:8px;">${title}</div>
                <div style="font-size:13px; color:var(--text1); margin-bottom:24px; line-height:1.6;">${msg}</div>
                <button class="login-btn" style="width:120px; background:${color};" onclick="window._dbm.closeAlertDialog()">Dismiss</button>
            </div>
        </div>
    `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function showConfirmDialog(title, msg, onConfirm) {
  const modalHtml = `
        <div id="custom-confirm-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:10000; backdrop-filter:blur(4px); animation: fadeIn 0.2s ease;">
            <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); padding:28px; width:400px; box-shadow:0 32px 64px rgba(0,0,0,0.5); text-align:center;">
                <div style="width:50px; height:50px; border-radius:50%; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:24px; border:2px solid var(--accent-dim);">
                    ❓
                </div>
                <div style="font-family:var(--font-display); font-size:18px; font-weight:700; color:var(--text0); margin-bottom:8px;">${title}</div>
                <div style="font-size:13px; color:var(--text1); margin-bottom:24px; line-height:1.6;">${msg}</div>
                <div style="display:flex; gap:12px; justify-content:center;">
                    <button class="btn" style="width:100px;" onclick="document.getElementById('custom-confirm-overlay').remove()">Cancel</button>
                    <button id="confirm-yes-btn" class="login-btn" style="width:100px; margin-top:0;">Confirm</button>
                </div>
            </div>
        </div>
    `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Attach the actual action to the "Yes" button
  document.getElementById('confirm-yes-btn').onclick = () => {
    document.getElementById('custom-confirm-overlay').remove();
    onConfirm();
  };
}

export function closeAlertDialog() {
  const el = document.getElementById('custom-alert-overlay');
  if (el) el.remove();
}

export function showMsg(m, t = 'success') {
  this.S.msg = m; this.S.msgType = t;
  this.renderPanel();
  setTimeout(() => { this.S.msg = null; this.renderPanel(); }, 4000);
}

export function updateStatus() {
  const d = document.getElementById('status-db');
  const t = document.getElementById('status-tbl');
  if (d) d.textContent = `DB: ${this.S.db}`;
  if (t) t.textContent = `Table: ${this.S.table}`;
}

export function renderShell() {
  if (!this.S.isLoggedIn) {
    this.container.innerHTML = `
          <div id="login-screen">
            <div class="login-box">
              <div class="login-logo">DB<em style="color:var(--accent)">Manager</em></div>
              <div class="login-sub">MySQL / MariaDB Administration</div>
              <div class="form-row" style="margin-bottom:12px; display:none;"><label>Host / Port</label><input value="localhost:3306" id="inp-host" /></div>
              <div class="form-row" style="margin-bottom:12px"><label>Username</label><input value="root" id="inp-user" /></div>
              <div class="form-row" style="margin-bottom:12px"><label>Password</label><input type="password" placeholder="••••••••" id="inp-pass" /></div>
              <div class="form-row" style="margin-bottom:12px; display:none;"><label>Database</label><input placeholder="e.g. my_database" id="inp-db" /></div>
              <button class="login-btn" onclick="window._dbm.doLogin()">Connect →</button>
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
              <div class="brand">DB<em>Manager</em></div>
              <div class="conn-pill"><div class="conn-dot"></div><span id="conn-label">${this.S.user}@${this.S.host}</span></div>
              <div class="top-spacer"></div>
              <button class="top-btn" onclick="window._dbm.showTab('sql')">Query</button>
              <button class="top-btn danger" onclick="window._dbm.doLogout()">Logout</button>
            </div>
            <div id="main">
              <div id="sidebar">
                <div class="sidebar-header"><input class="sidebar-search" placeholder="Search tables…" oninput="window._dbm.renderSidebar(this.value)" /></div>
                <div class="sidebar-scroll" id="sidebar-content"></div>
              </div>
              <div id="content">
                <div id="tabbar">
                  <div class="tab active" id="tab-browse" onclick="window._dbm.showTab('browse')">▤ Browse</div>
                  <div class="tab" id="tab-structure" onclick="window._dbm.showTab('structure')">⊞ Structure</div>
                  <div class="tab" id="tab-sql" onclick="window._dbm.showTab('sql')">❯ SQL</div>
                </div>
                <div id="panel"></div>
              </div>
            </div>
            <div id="statusbar">
              <div class="status-item green">● Connected</div>
              <div class="status-item" id="status-db">DB: —</div>
              <div class="status-item" id="status-tbl">Table: —</div>
            </div>
          </div>`;
    this.renderSidebar();
  }
}

export function renderSidebar(filter = '') {
  const el = document.getElementById('sidebar-content');
  if (!el) return;
  let html = '';

  Object.entries(this.APP.databases).forEach(([db, info]) => {
    const isActiveDb = this.S.db === db;
    const isOpen = this.S.expandedDbs.has(db);
    if (!(!filter || db.includes(filter)) && !info.tables.some(t => t.includes(filter))) return;

    html += `
          <div class="db-row ${isActiveDb ? 'active' : ''} ${isOpen ? 'open' : ''}" onclick="window._dbm.toggleDb('${db}')">
            <svg class="db-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="6" ry="2.5" stroke="currentColor" stroke-width="1.1"/><path d="M2 4v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V4" stroke="currentColor" stroke-width="1.1"/><path d="M2 8v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V8" stroke="currentColor" stroke-width="1.1"/></svg>
            ${db}
            <span class="db-arrow">▶</span>
          </div>`;

    if (isOpen) {
      info.tables.filter(t => !filter || t.includes(filter)).forEach(t => {
        const isActiveTable = (this.S.db === db && this.S.table === t);
        html += `
              <div class="tbl-row ${isActiveTable ? 'active' : ''}" onclick="window._dbm.selectTable('${db}', '${t}')">
                 <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="0.9"/><line x1="1" y1="4.2" x2="11" y2="4.2" stroke="currentColor" stroke-width="0.7"/><line x1="1" y1="7.5" x2="11" y2="7.5" stroke="currentColor" stroke-width="0.7"/><line x1="4.5" y1="4.2" x2="4.5" y2="11" stroke="currentColor" stroke-width="0.7"/></svg>
                ${t}
              </div>`;
      });
    }
  });

  el.innerHTML = html || '<div style="padding:16px;color:var(--text3);font-size:11px">No matches</div>';
}

export function renderPanel() {
  const p = document.getElementById('panel');
  if (!p) return;
  if (!this.S.table && this.S.tab !== 'sql') { p.innerHTML = '<div style="color:var(--text3)">Select a table to begin.</div>'; return; }

  const msgHtml = this.S.msg ? `<div class="result-msg ${this.S.msgType}">${this.S.msgType === 'success' ? '✓' : '✕'} ${this.S.msg}</div>` : '';

  if (this.S.tab === 'browse') {
    const headers = this.APP.colHeaders[this.S.table] || [];
    let rowsWithIndex = (this.APP.tableData[this.S.table] || []).map((row, originalIndex) => ({ row, originalIndex }));

    if (this.S.appliedFilters.length > 0) {
      rowsWithIndex = rowsWithIndex.filter(({ row }) => {
        return this.S.appliedFilters.every(f => {
          if (!f.active || !f.col || !f.op) return true;
          const colIdx = headers.indexOf(f.col);
          if (colIdx === -1) return true;

          const cellVal = row[colIdx];
          const filterVal = f.val.toLowerCase();
          const cellStr = String(cellVal ?? '').toLowerCase();

          switch (f.op) {
            case '=': return cellStr === filterVal;
            case '!=': return cellStr !== filterVal;
            case 'contains': return cellStr.includes(filterVal);
            case 'starts with': return cellStr.startsWith(filterVal);
            case 'ends with': return cellStr.endsWith(filterVal);
            case '>': return Number(cellVal) > Number(f.val);
            case '<': return Number(cellVal) < Number(f.val);
            case '>=': return Number(cellVal) >= Number(f.val);
            case '<=': return Number(cellVal) <= Number(f.val);
            case 'is null': return cellVal === null;
            case 'is not null': return cellVal !== null;
            default: return true;
          }
        });
      });
    }

    if (this.S.appliedSorts.length > 0) {
      rowsWithIndex.sort((a, b) => {
        for (const s of this.S.appliedSorts) {
          if (!s.col) continue;
          const colIdx = headers.indexOf(s.col);
          const valA = a.row[colIdx];
          const valB = b.row[colIdx];
          if (valA === valB) continue;
          const cmp = valA == null ? -1 : valB == null ? 1 : valA > valB ? 1 : -1;
          return s.dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    const total = rowsWithIndex.length;
    const totalPages = Math.max(1, Math.ceil(total / this.S.perPage));
    if (this.S.page > totalPages) this.S.page = totalPages;

    const start = (this.S.page - 1) * this.S.perPage;
    const pageRowsWithIndex = rowsWithIndex.slice(start, start + this.S.perPage);

    const pageRowsIndices = pageRowsWithIndex.map(item => item.originalIndex);
    const allSelectedOnPage = pageRowsIndices.length > 0 && pageRowsIndices.every(idx => this.S.selected.has(idx));

    const schema = this.APP.schemas[this.S.table] || [];
    const pkIndex = schema.findIndex(c => c.x === 'PK');

    const tbodyHtml = pageRowsWithIndex.map((item, localIdx) => {
      const r = item.row;
      const actualRowIndex = item.originalIndex;
      const isSelected = this.S.selected.has(actualRowIndex);
      return `<tr style="${isSelected ? 'background: var(--accent-dim2);' : ''}">
            <td style="width:34px;text-align:center;">
              <input type="checkbox" onchange="window._dbm.toggleRow(${actualRowIndex})" ${isSelected ? 'checked' : ''} style="cursor:pointer; accent-color:var(--accent);" />
            </td>
            <td style="color:var(--text3); font-size:10px;">${start + localIdx + 1}</td>
            ${r.map((c, cIdx) => {
        const isPk = cIdx === pkIndex;
        return `<td ${!isPk ? `contenteditable="true" spellcheck="false" style="outline:none; transition: background 0.3s;" onblur="window._dbm.saveCell(${actualRowIndex}, ${cIdx}, this)" title="Click to edit"` : 'style="opacity:0.6; cursor:not-allowed;" title="Primary Key"'} >${c !== null ? c : ''}</td>`;
      }).join('')}
          </tr>`;
    }).join('');

    const ops = ['=', '!=', 'contains', 'starts with', 'ends with', '>', '<', '>=', '<=', 'is null', 'is not null'];
    let builderHtml = '';
    if (this.S.showBuilder) {
      builderHtml = `
            <div style="background:var(--bg1); border:1px solid var(--line); border-radius:var(--radius-lg); padding:16px; margin-bottom:16px;">
              <div style="font-weight:600; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                Filter <button class="btn" style="padding:2px 6px; font-size:10px;" onclick="window._dbm.addFilter()">+</button>
              </div>
              ${this.S.filters.length === 0 ? '<div style="color:var(--text3); font-size:11px; margin-bottom:12px;">No filters applied.</div>' : ''}
              ${this.S.filters.map((f, i) => `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                  <input type="checkbox" ${f.active ? 'checked' : ''} onchange="window._dbm.updateFilter(${f.id}, 'active', this.checked)" style="accent-color:var(--accent);" />
                  <select class="search-input" style="width:140px;" onchange="window._dbm.updateFilter(${f.id}, 'col', this.value)">
                    ${headers.map(h => `<option value="${h}" ${f.col === h ? 'selected' : ''}>${h}</option>`).join('')}
                  </select>
                  <select class="search-input" style="width:110px;" onchange="window._dbm.updateFilter(${f.id}, 'op', this.value)">
                    ${ops.map(o => `<option value="${o}" ${f.op === o ? 'selected' : ''}>${o}</option>`).join('')}
                  </select>
                  ${!f.op.includes('null') ? `<input class="search-input" style="flex:1;" placeholder="value <?>" value="${f.val}" oninput="window._dbm.updateFilter(${f.id}, 'val', this.value)" />` : '<div style="flex:1;"></div>'}
                  <button class="btn danger" style="padding:4px 8px;" onclick="window._dbm.removeFilter(${f.id})">✕</button>
                </div>
              `).join('')}
  
              <div style="font-weight:600; margin-top:20px; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                Sort By <button class="btn" style="padding:2px 6px; font-size:10px;" onclick="window._dbm.addSort()">+</button>
              </div>
              ${this.S.sorts.length === 0 ? '<div style="color:var(--text3); font-size:11px;">Click "+" to add sort criteria</div>' : ''}
              ${this.S.sorts.map(s => `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                  <select class="search-input" style="width:140px;" onchange="window._dbm.updateSort(${s.id}, 'col', this.value)">
                    ${headers.map(h => `<option value="${h}" ${s.col === h ? 'selected' : ''}>${h}</option>`).join('')}
                  </select>
                  <select class="search-input" style="width:100px;" onchange="window._dbm.updateSort(${s.id}, 'dir', this.value)">
                    <option value="asc" ${s.dir === 'asc' ? 'selected' : ''}>ASC ↑</option>
                    <option value="desc" ${s.dir === 'desc' ? 'selected' : ''}>DESC ↓</option>
                  </select>
                  <button class="btn danger" style="padding:4px 8px;" onclick="window._dbm.removeSort(${s.id})">✕</button>
                </div>
              `).join('')}
              
              <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--line); display:flex; justify-content:flex-end;">
                 <button class="btn primary" onclick="window._dbm.applyQueryBuilder()">▶ Apply Filters & Sort</button>
              </div>
            </div>
          `;
    }

    p.innerHTML = `${msgHtml}
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap: wrap; gap: 10px;">
              <div class="section-title" style="margin:0;">Data <span class="badge">${this.S.table}</span></div>
              <div class="page-info" style="display:flex; align-items:center;">
                  <button class="btn ${this.S.showBuilder ? 'primary' : ''}" style="margin-right:14px;" onclick="window._dbm.S.showBuilder = !window._dbm.S.showBuilder; window._dbm.renderPanel();">
                     <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;"><path d="M1 3h14v2H1V3zm2 4h10v2H3V7zm3 4h4v2H6v-2z"/></svg>
                     Advanced Filter
                  </button>
                  <span style="margin-right:14px;">${total} rows</span>
                  <button class="btn" onclick="window._dbm.changePage(-1)" ${this.S.page <= 1 ? 'disabled' : ''}>←</button>
                  <span style="margin: 0 8px;">Page ${this.S.page} / ${totalPages}</span>
                  <button class="btn" onclick="window._dbm.changePage(1)" ${this.S.page >= totalPages ? 'disabled' : ''}>→</button>
                  <select class="search-input" style="width:70px; margin-left:14px;" onchange="window._dbm.setPerPage(this.value)">
                      ${[15, 50, 100, 500].map(n => `<option ${this.S.perPage === n ? 'selected' : ''}>${n}</option>`).join('')}
                  </select>
              </div>
          </div>
  
          ${builderHtml}
  
          <div class="toolbar" style="margin-bottom: 14px; display: flex; gap: 8px; border-bottom: 1px solid var(--line); padding-bottom: 14px;">
              <button class="btn danger" onclick="window._dbm.deleteSelected()" ${this.S.selected.size === 0 ? 'disabled' : ''}>✕ Delete (${this.S.selected.size})</button>
              <button class="btn" onclick="window._dbm.copySelected()" ${this.S.selected.size === 0 ? 'disabled' : ''}>⎘ Copy Selected</button>
              <div style="margin-left: auto; display: flex; gap: 8px;">
                  <button class="btn success" onclick="window._dbm.exportSelected('csv')">↓ Export CSV</button>
                  <button class="btn amber" onclick="window._dbm.exportSelected('json')">↓ Export JSON</button>
              </div>
          </div>
  
          <div class="tbl-wrapper">
              <table class="data-tbl">
                  <thead><tr>
                    <th style="width:34px; text-align:center;"><input type="checkbox" onchange="window._dbm.toggleAll(this.checked, ${JSON.stringify(pageRowsIndices)})" ${allSelectedOnPage ? 'checked' : ''} style="cursor:pointer; accent-color:var(--accent);" title="Select page" /></th>
                    <th style="width:34px;">#</th>
                    ${headers.map(h => `<th>${h}</th>`).join('')}
                  </tr></thead>
                  <tbody>${tbodyHtml || `<tr><td colspan="${headers.length + 2}" style="text-align:center;padding:32px;color:var(--text3)">No data found</td></tr>`}</tbody>
              </table>
          </div>`;
  }
  else if (this.S.tab === 'structure') {
    const cols = this.APP.schemas[this.S.table] || [];

    const colRows = cols.map(c => {
      const isPk = c.x.includes('PK');
      const hasIndex = c.x !== '';
      return `<tr>
                <td style="font-weight:600;color:var(--text0)">${c.n}</td>
                <td><span class="pill varchar">${c.t}</span></td>
                <td><span style="color:var(--text3); font-size:10px;">${c.collate || '—'}</span></td>
                <td><span class="pill ${c.extra.includes('auto_increment') ? 'pk' : 'text'}">${c.extra || '—'}</span></td>
                <td>${c.null ? '<span style="color:var(--green)">YES</span>' : '<span style="color:var(--text3)">NO</span>'}</td>
                <td><span style="color:var(--text2)">${c.def !== null ? c.def : '<span class="null-val">NULL</span>'}</span></td>
                <td><span style="color:var(--text3); font-size:11px;">${c.comment || ''}</span></td>
                <td style="text-align:right;">
                    <button class="btn" style="padding:3px 8px; font-size:10px;" onclick="window._dbm.openColumnEditor('${c.n}')">✎ Edit</button>
                    
                    <span style="display:inline-flex; border-left:1px solid var(--line); border-right:1px solid var(--line); margin:0 6px; padding:0 6px; gap:4px;">
                        <button class="btn" style="padding:3px; background:transparent; border:none; ${hasIndex ? 'opacity:0.3; cursor:not-allowed' : ''}" title="Add Primary Key" ${hasIndex ? 'disabled' : `onclick="window._dbm.addIndex('${c.n}', 'PRIMARY')"`}>🔑</button>
                        <button class="btn" style="padding:3px; background:transparent; border:none; ${hasIndex ? 'opacity:0.3; cursor:not-allowed' : ''}" title="Add Unique Index" ${hasIndex ? 'disabled' : `onclick="window._dbm.addIndex('${c.n}', 'UNIQUE')"`}>U</button>
                        <button class="btn" style="padding:3px; background:transparent; border:none; ${hasIndex ? 'opacity:0.3; cursor:not-allowed' : ''}" title="Add Standard Index" ${hasIndex ? 'disabled' : `onclick="window._dbm.addIndex('${c.n}', 'INDEX')"`}>I</button>
                    </span>

                    <button class="btn danger" style="padding:3px 8px; font-size:10px;" 
                        ${isPk ? 'disabled title="Cannot drop Primary Key"' : `onclick="window._dbm.dropColumn('${c.n}')"`}>
                        ✕ Drop
                    </button>
                </td>
            </tr>`;
    }).join('');

    p.innerHTML = `${msgHtml}
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <div class="section-title" style="margin:0;">Structure <span class="badge">${this.S.table}</span></div>
              <button class="btn primary" onclick="window._dbm.openColumnEditor(null)">＋ Add Column</button>
          </div>
          <div class="tbl-wrapper">
              <table class="data-tbl">
                  <thead><tr>
                    <th>Name</th>
                    <th>Type / Length</th>
                    <th>Collation</th>
                    <th>Attributes</th>
                    <th>Null</th>
                    <th>Default</th>
                    <th>Comments</th>
                    <th style="text-align:right;">Actions</th>
                  </tr></thead>
                  <tbody>${colRows}</tbody>
              </table>
          </div>`;

    if (!this.S.currentIndexes) {
      this.loadIndexes(); // Initial fetch if not loaded
      return p.innerHTML = '<div style="padding:20px; color:var(--text3);">Loading structure...</div>';
    }

    const indexRows = this.S.currentIndexes.map(idx => `
            <tr>
                <td>
                    <button class="btn" style="padding:2px 6px; font-size:10px; background:transparent;">✎ Edit</button>
                    <button class="btn danger" style="padding:2px 6px; font-size:10px; margin-left:4px;" onclick="window._dbm.dropIndex('${idx.Key_name}')">✕ Drop</button>
                </td>
                <td class="fw-bold">${idx.Key_name}</td>
                <td>${idx.Index_type}</td>
                <td>${idx.Non_unique === '0' ? 'Yes' : 'No'}</td>
                <td>${idx.Column_name}</td>
                <td style="color:var(--text3); font-size:11px;">${idx.Cardinality}</td>
                <td>${idx.Collation || 'A'}</td>
                <td>${idx.Null || 'No'}</td>
            </tr>
        `).join('');

    p.innerHTML = `
          ${msgHtml}
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <div class="section-title" style="margin:0;">Structure <span class="badge">${this.S.table}</span></div>
              <button class="btn primary" onclick="window._dbm.openColumnEditor(null)">＋ Add Column</button>
          </div>
          <div class="tbl-wrapper" style="margin-bottom:40px;">
              <table class="data-tbl">
                  <thead><tr><th>Name</th><th>Type</th><th>Collation</th><th>Extra</th><th>Null</th><th>Default</th><th style="text-align:right;">Actions</th></tr></thead>
                  <tbody>${colRows}</tbody>
              </table>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <div class="section-title" style="margin:0;">Indexes <span class="badge">${this.S.currentIndexes.length}</span></div>
              <button class="btn" onclick="window._dbm.openAddIndexModal()">＋ Add Index</button>
          </div>
          <div class="tbl-wrapper">
              <table class="data-tbl">
                  <thead><tr>
                    <th>Action</th><th>Keyname</th><th>Type</th><th>Unique</th><th>Column</th><th>Cardinality</th><th>Collation</th><th>Null</th>
                  </tr></thead>
                  <tbody>${indexRows || '<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text3);">No indexes found</td></tr>'}</tbody>
              </table>
          </div>`;

  }
  else if (this.S.tab === 'sql') {
    const defaultSQL = this.S.table ? `SELECT *\nFROM ${this.S.table}\nLIMIT 20;` : 'SHOW DATABASES;';
    const displayHeaders = this.S.queryHeaders.length > 0 ? this.S.queryHeaders : (this.APP.colHeaders[this.S.table] || []);

    let resHtml = '';
    if (this.S.queryResult) {
      resHtml = `<div style="margin-top:18px"><div class="section-title">Result <span class="badge">${this.S.queryResult.length} rows</span></div>
           <div class="tbl-wrapper"><table class="data-tbl"><thead><tr>${displayHeaders.map(h => `<th>${h}</th>`).join('')}</tr></thead>
           <tbody>${this.S.queryResult.map(r => `<tr>${r.map(c => `<td>${c !== null ? c : '<span class="null-val">NULL</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
    }
    p.innerHTML = `${msgHtml}<div class="section-title">SQL Query Editor</div>
          <textarea class="sql-editor" id="sql-input">${defaultSQL}</textarea>
          <button class="btn primary" style="margin-top:10px" onclick="window._dbm.runQuery()">▶ Execute</button>
          ${resHtml}`;
  }
}