import { exportData, downloadFile, formatBytes } from './export.js';
import { esc, escJs } from './util.js';
import { columnInputSpec } from './cellinput.js';

// Ids for sort rules created by clicking a column header. A counter can't
// collide the way Date.now() can within one millisecond.
let nextClauseId = 1;

/** Open or close the filter bar. Opening it with no conditions starts one. */
export function toggleQueryBuilder() {
    this.S.showBuilder = !this.S.showBuilder;
    const hasConditions = (this.S.filters || []).some(f => !String(f.id).startsWith('qcol_'));
    if (this.S.showBuilder && !hasConditions && !(this.S.sorts || []).length) {
        this.fbAdd(); // renders, with the cursor on the new condition
        return;
    }
    this.renderPanel();
}

export function toggleRow(idx) {
    if (this.S.selected.has(idx)) this.S.selected.delete(idx);
    else this.S.selected.add(idx);
    this.renderPanel();
}

export function toggleAll(checked, pageRowsIndices) {
    if (!pageRowsIndices || !Array.isArray(pageRowsIndices)) {
        const rowCount = (this.APP.tableData[this.S.table] || []).length;
        pageRowsIndices = Array.from({ length: rowCount }, (_, i) => i);
    }
    for (let idx of pageRowsIndices) {
        if (checked) this.S.selected.add(idx);
        else this.S.selected.delete(idx);
    }
    this.renderPanel();
}

export function confirmLogout() {
    this.showConfirmDialog(
        "Sign Out",
        "Are you sure you want to log out of this database session?",
        () => this.doLogout(),
        { confirmText: "Logout", cancelText: "Cancel", type: "warning" }
    );
}

export function confirmClearTerminal() {
    this.showConfirmDialog(
        "Clear Console Logs",
        "Are you sure you want to clear the console output log history?",
        () => this.clearTerminal(),
        { confirmText: "Clear Logs", cancelText: "Cancel", type: "warning" }
    );
}

export async function deleteSelected() {
    if (!this.S.selected.size) return;

    const count = this.S.selected.size;
    this.showConfirmDialog(
        "Delete Rows",
        `Are you sure you want to permanently delete ${count} selected row(s)? This action cannot be undone.`,
        async () => {
            const table = this.S.table;
            const schema = this.APP.schemas[table] || [];
            const pkIndex = schema.findIndex(c => c.x === 'PK');

            if (pkIndex === -1) return this.showMsg("Table requires a Primary Key to delete rows.", "error");

            let successCount = 0;
            for (const idx of this.S.selected) {
                const rowData = this.APP.tableData[table]?.[idx];
                if (!rowData) continue;
                const pkVal = rowData[pkIndex];
                try {
                    const res = await fetch(`${this.apiUrl}?action=delete_row`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ db: this.S.db, table, pk_col: this.APP.colHeaders[table][pkIndex], pk_val: pkVal })
                    });
                    const data = await res.json();
                    if (res.ok && data.success) successCount++;
                } catch (e) { console.error(e); }
            }

            this.S.selected.clear();
            this.showMsg(`Deleted ${successCount} row(s).`);
            await this.loadTableDataFromServer(this.S.db, table);
        },
        { confirmText: `Delete (${count})`, cancelText: "Cancel", type: "danger" }
    );
}

export async function copySelected() {
    if (!this.S.selected.size) return;

    const table = this.S.table;
    const schema = this.APP.schemas[table] || [];
    const pkIndex = schema.findIndex(c => c.x === 'PK');

    let successCount = 0;
    for (const idx of this.S.selected) {
        const rowData = this.APP.tableData[table]?.[idx];
        if (!rowData) continue;
        let insertData = {};

        this.APP.colHeaders[table].forEach((h, i) => {
            const colDef = schema[i];
            const isAi = colDef && (colDef.extra || '').includes('auto_increment');
            if (i !== pkIndex && !isAi) {
                insertData[h] = rowData[i];
            }
        });

        try {
            const res = await fetch(`${this.apiUrl}?action=insert_row`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ db: this.S.db, table, data: insertData })
            });
            const data = await res.json();
            if (res.ok && data.success) successCount++;
        } catch (e) { console.error(e); }
    }

    this.S.selected.clear();
    this.showMsg(`Duplicated ${successCount} row(s).`);
    await this.loadTableDataFromServer(this.S.db, table);
}

export function openInsertRowModal() {
    const table = this.S.table;
    const schema = this.APP.schemas[table] || [];
    const fieldsHtml = schema.map((col, idx) => {
        const isAi = (col.extra || '').includes('auto_increment');
        const isPk = col.x === 'PK';
        const fkMeta = this.fkMetaFor(col.n, table);

        const fieldId = `ins-col-${esc(col.n)}`;

        let inputControl = '';
        if (fkMeta) {
            // A hidden input carries the value (submitInsertRow reads it by id);
            // the button opens the same searchable picker as the grid.
            inputControl = `
                <input type="hidden" id="${fieldId}" value="" data-empty="${col.null ? '0' : '1'}">
                <button type="button" class="search-input fk-field" data-target="${fieldId}"
                        onclick="window._dbm.openInsertFkPicker(this, '${escJs(col.n)}')"
                        title="Choose a ${esc(fkMeta.table)} row">
                    <span class="fk-field-text">${col.null ? '<span class="null-val">NULL</span>' : `<span class="fk-field-placeholder">Select ${esc(fkMeta.table)}…</span>`}</span>
                    <i class="ti ti-selector" aria-hidden="true"></i>
                </button>
            `;
        } else if (col.t.toLowerCase().startsWith('enum')) {
            const match = col.t.match(/^enum\((.*)\)$/i);
            let opts = [];
            if (match) {
                const rawOptions = match[1];
                const regex = /'((?:''|[^'])*)'/g;
                let m;
                while ((m = regex.exec(rawOptions)) !== null) {
                    opts.push(m[1].replace(/''/g, "'"));
                }
            }
            inputControl = `
                <select id="${fieldId}" class="search-input" style="width:100%">
                    ${col.null ? '<option value="">[NULL]</option>' : '<option value="" disabled selected>Select option...</option>'}
                    ${opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
                </select>
            `;
        } else if (col.t.toLowerCase().includes('text')) {
            inputControl = `<textarea id="${fieldId}" class="search-input" style="width:100%; height:60px; resize:vertical;" placeholder="${col.null ? 'NULL' : ''}"></textarea>`;
        } else {
            // Dates and times get the browser's picker; numbers are checked as you type.
            const spec = columnInputSpec(col);
            const attrs = spec ? Object.entries(spec.attrs || {}).map(([k, v]) => `${k}="${esc(v)}"`).join(' ') : '';
            const placeholder = isAi ? 'Auto Increment (leave blank)' : (col.def !== null ? `Default: ${col.def}` : (col.null ? 'NULL' : ''));
            const hint = spec && !isAi
                ? spec.hint + (col.def !== null ? ` · leave empty for the default (${col.def})` : (col.null ? ' · leave empty for NULL' : ''))
                : '';
            inputControl = `<input id="${fieldId}" class="search-input" style="width:100%" type="${spec ? spec.type : 'text'}" ${attrs}
                    placeholder="${esc(placeholder)}"
                    ${spec ? `oninput="window._dbm.validateInsertField(this, '${escJs(col.n)}')"` : ''} />
                ${hint ? `<div class="ins-hint" id="${fieldId}-hint">${esc(hint)}</div>` : ''}`;
        }

        return `
            <div style="margin-bottom:12px;">
                <label style="display:flex; justify-content:space-between; font-size:11px; color:var(--text1); margin-bottom:4px; font-weight:500;">
                    <span>${esc(col.n)} <span style="color:var(--text3); font-size:10px;">(${esc(col.t)})</span></span>
                    <span style="font-size:10px; color:var(--text3);">${isAi ? 'AUTO_INCREMENT' : (isPk ? 'PRIMARY KEY' : (col.null ? 'NULL' : 'NOT NULL'))}</span>
                </label>
                ${inputControl}
            </div>
        `;
    }).join('');

    const modalHtml = `
        <div id="insert-modal-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter:blur(3px);">
            <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); padding:24px; width:520px; max-height:85vh; overflow-y:auto; box-shadow:0 24px 64px rgba(0,0,0,0.6);">
                <div style="font-family:var(--font-display); font-size:16px; font-weight:700; margin-bottom:18px; color:var(--text0);">
                    <i class="ti ti-plus" aria-hidden="true"></i> Insert New Row into <span style="color:var(--accent)">${esc(table)}</span>
                </div>
                <div id="insert-form">
                    ${fieldsHtml}
                </div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px; border-top:1px solid var(--line); padding-top:16px;">
                    <button class="btn" onclick="document.getElementById('insert-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitInsertRow()">Insert Row</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * Live check of a typed Insert Row field (date, time, number). Marks the field and
 * shows the problem under it; returns the parsed { value } or null if invalid.
 * Empty is fine here: submitInsertRow decides between NULL and the default.
 */
export function validateInsertField(el, colName) {
    const col = (this.APP.schemas[this.S.table] || []).find(c => c.n === colName);
    const spec = columnInputSpec(col);
    if (!spec) return { value: el.value };
    const result = spec.parse(el.value);
    const error = !result.ok ? result.error : (el.validity?.badInput ? 'Finish entering the value.' : '');
    el.classList.toggle('invalid', !!error);
    el.setAttribute('aria-invalid', error ? 'true' : 'false');
    const hintEl = document.getElementById(`${el.id}-hint`);
    if (hintEl) {
        if (!hintEl.dataset.base) hintEl.dataset.base = hintEl.textContent;
        hintEl.textContent = error || hintEl.dataset.base;
        hintEl.classList.toggle('error', !!error);
    }
    return error ? null : result;
}

export async function submitInsertRow() {
    const table = this.S.table;
    const schema = this.APP.schemas[table] || [];
    let insertData = {};
    const invalid = [];

    schema.forEach(col => {
        const isAi = (col.extra || '').includes('auto_increment');
        const el = document.getElementById(`ins-col-${col.n}`);
        if (!el) return;

        let val = el.value;
        // Typed fields: validate, and send MySQL's format (e.g. "2024-07-02 13:45:00").
        if (el.tagName === 'INPUT' && el.type !== 'hidden' && columnInputSpec(col)) {
            const checked = this.validateInsertField(el, col.n);
            if (!checked) { invalid.push(el); return; }
            val = checked.value;
        }
        if (isAi && val.trim() === '') {
            // Skip auto_increment if empty
            return;
        }

        if (val === '') {
            if (col.null) {
                insertData[col.n] = null;
            } else if (col.def !== null) {
                // If default exists and empty, omit so MySQL uses default
                return;
            } else if (/(int|float|double|decimal|numeric|bit)/i.test(col.t)) {
                insertData[col.n] = 0;
            } else {
                insertData[col.n] = '';
            }
        } else {
            insertData[col.n] = val;
        }
    });

    if (invalid.length) {
        invalid[0].focus();
        const names = invalid.map(el => el.id.replace(/^ins-col-/, '')).join(', ');
        this.showMsg(`Fix the highlighted field${invalid.length === 1 ? '' : 's'} first: ${names}`, 'error');
        return;
    }

    try {
        const res = await fetch(`${this.apiUrl}?action=insert_row`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: this.S.db, table, data: insertData })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to insert row');

        const modal = document.getElementById('insert-modal-overlay');
        if (modal) modal.remove();

        this.showMsg(`New row inserted successfully.`);
        await this.loadTableDataFromServer(this.S.db, table);
    } catch (err) {
        this.showMsg(err.message, "error");
    }
}

export function exportSelected(format) {
    const table = this.S.table;
    const headers = this.APP.colHeaders[table] || [];
    let rowsToExport = this.APP.tableData[table] || [];

    if (this.S.selected.size > 0) {
        const indices = Array.from(this.S.selected).sort((a, b) => a - b);
        rowsToExport = indices.map(i => this.APP.tableData[table][i]).filter(Boolean);
    }

    exportData(format, table, headers, rowsToExport);
}

export function changePage(delta) {
    if (this.S.tab === 'sql') {
        // SQL results page on their own, separately from the Browse grid.
        const r = (this.S.sqlResults || [])[this.S.sqlActive];
        if (r) this.sqlGoToPage(this.S.sqlActive, (r.page || 1) + delta);
    } else {
        this.S.page = Math.max(1, (this.S.page || 1) + delta);
        this.loadTableDataFromServer(this.S.db, this.S.table);
    }
}

export function setPerPage(val) {
    this.S.perPage = parseInt(val, 10) || 25;
    this.S.page = 1;
    this.saveLocalState();
    if (this.S.tab === 'sql') {
        this.sqlGoToPage(this.S.sqlActive || 0, 1);
    } else {
        this.loadTableDataFromServer(this.S.db, this.S.table);
    }
}

export function selectDb(db) {
    this.S.db = db;
    this.S.table = this.APP.databases[db]?.tables?.[0] || '';
    this.S.page = 1;
    this.S.selected.clear();
    this.S.filters = [];
    this.S.appliedFilters = [];
    this.S.sorts = [];
    this.S.appliedSorts = [];
    this.S.currentIndexes = null;

    this.saveLocalState();

    if (this.S.table) {
        this.loadTableDataFromServer(this.S.db, this.S.table);
    } else {
        this.renderSidebar();
        this.renderPanel();
        this.updateStatus();
    }
}

/**
 * Open a table. `colFilters` (e.g. { id: '=5' }) opens it already filtered,
 * which is how jumping along a relationship lands on the referenced row.
 */
export function selectTable(db, t, colFilters = null) {
    this.S.db = db;
    this.S.table = t;
    this.S.page = 1;
    this.S.selected.clear();
    this.S.filters = [];
    this.S.appliedFilters = [];
    this.S.colFilters = {};
    this.S.sorts = [];
    this.S.appliedSorts = [];
    this.S.filterMatch = 'all';
    this.S.appliedMatch = 'all';
    this.S.currentIndexes = null;
    this.S.expandedDbs.add(db);

    // Opening a table from the Objects list should show its rows.
    if (this.S.tab === 'objects') {
        this.S.tab = 'browse';
        document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.id === 'tab-browse'));
    }

    // On phones, picking a table slides the drawer away to show it.
    if (window.innerWidth <= 768) this.setSidebarOpen(false);

    if (colFilters) {
        this.S.colFilters = { ...colFilters };
        this.applyColumnFilters(); // saves state and loads the filtered rows
        return;
    }

    this.saveLocalState();
    this.loadTableDataFromServer(this.S.db, this.S.table);
}

export function toggleSortByCol(col) {
    if (!this.S.sorts) this.S.sorts = [];
    const existingIdx = this.S.sorts.findIndex(s => s.col === col);
    if (existingIdx !== -1) {
        const current = this.S.sorts[existingIdx];
        if (current.dir === 'asc') {
            current.dir = 'desc';
        } else {
            this.S.sorts.splice(existingIdx, 1);
        }
    } else {
        this.S.sorts = [{ id: nextClauseId++, col: col, dir: 'asc' }];
    }
    this.S.appliedSorts = JSON.parse(JSON.stringify(this.S.sorts));
    this.S.page = 1;
    this.saveLocalState();
    this.loadTableDataFromServer(this.S.db, this.S.table);
}

export function toggleFilterRow() {
    this.S.showFilterRow = !this.S.showFilterRow;
    this.saveLocalState();
    this.renderPanel();
}

export function setColumnFilter(col, val) {
    if (!this.S.colFilters) this.S.colFilters = {};
    if (val.trim() === '') {
        delete this.S.colFilters[col];
    } else {
        this.S.colFilters[col] = val.trim();
    }
}

export function applyColumnFilters() {
    if (!this.S.colFilters) this.S.colFilters = {};
    const advancedFilters = (this.S.filters || []).filter(f => !String(f.id).startsWith('qcol_'));
    const quickFilters = Object.entries(this.S.colFilters).map(([col, rawVal]) => {
        // On a relationship column plain text matches the ID or the referenced name.
        let op = this.fkMetaFor(col) ? 'fk' : '=';
        let val = rawVal;
        if (typeof rawVal === 'string') {
            const trimmed = rawVal.trim();
            if (/^null$/i.test(trimmed)) {
                op = 'is null';
            } else if (/^(!|!=|<>)\s*null$/i.test(trimmed)) {
                op = 'is not null';
            } else if (trimmed.startsWith('!=') || trimmed.startsWith('<>')) {
                op = '!=';
                val = trimmed.replace(/^(!=|<>)\s*/, '');
            } else if (trimmed.startsWith('>=')) {
                op = '>=';
                val = trimmed.replace(/^>=\s*/, '');
            } else if (trimmed.startsWith('<=')) {
                op = '<=';
                val = trimmed.replace(/^<=\s*/, '');
            } else if (trimmed.startsWith('>')) {
                op = '>';
                val = trimmed.replace(/^>\s*/, '');
            } else if (trimmed.startsWith('<')) {
                op = '<';
                val = trimmed.replace(/^<\s*/, '');
            } else if (trimmed.startsWith('=')) {
                op = '=';
                val = trimmed.replace(/^=\s*/, '');
            } else if (trimmed.toLowerCase().startsWith('like ')) {
                op = 'contains';
                val = trimmed.replace(/^like\s+/i, '');
            }
        }
        return {
            id: `qcol_${col}`,
            active: true,
            col: col,
            op: op,
            val: val
        };
    });

    this.S.filters = [...advancedFilters, ...quickFilters];
    // Half-filled filter-bar conditions must not reach the server.
    this.S.appliedFilters = JSON.parse(JSON.stringify(this.completeFilters()));
    this.S.appliedMatch = this.S.filterMatch || 'all';
    this.S.page = 1;
    this.saveLocalState();
    this.loadTableDataFromServer(this.S.db, this.S.table);
}

export function clearSingleColumnFilter(col) {
    if (this.S.colFilters) {
        delete this.S.colFilters[col];
    }
    const inp = document.getElementById(`col-filter-${col}`);
    if (inp) inp.value = '';
    this.applyColumnFilters();
}

export function clearAllColumnFilters() {
    this.S.colFilters = {};
    this.applyColumnFilters();
}

export function handleDbRowClick(db) {
    // Like Navicat, clicking a database opens its Objects list. Clicking it again
    // while that list is already showing just expands / collapses the tree.
    if (this.S.db === db && this.S.tab === 'objects') {
        this.toggleDb(db);
        return;
    }
    if (this.S.db !== db) {
        this.S.db = db;
        this.S.table = '';
        this.S.page = 1;
        this.S.selected.clear();
        this.S.filters = [];
        this.S.appliedFilters = [];
        this.S.sorts = [];
        this.S.appliedSorts = [];
    }
    if (this.S.expandedDbs.has(db)) this.renderSidebar();
    else this.toggleDb(db); // slides it open
    this.updateStatus();
    this.showTab('objects');
}

export function toggleDb(db) {
    const isOpen = this.S.expandedDbs.has(db);
    const sel = `[data-db="${CSS.escape(db)}"]`;
    this.toggleTreeBranch(`.db-tables-container${sel}`, `.db-row${sel}`, isOpen, () => {
        if (isOpen) this.S.expandedDbs.delete(db);
        else this.S.expandedDbs.add(db);
        this.saveLocalState();
    });
}

export function onSidebarSearch(val) {
    const clearBtn = document.getElementById('sidebar-search-clear');
    if (clearBtn) clearBtn.style.display = val ? 'flex' : 'none';
    this.renderSidebar(val);
}

export function clearSidebarSearch() {
    const inp = document.getElementById('sidebar-search-input');
    if (inp) inp.value = '';
    this.onSidebarSearch('');
}

export function toggleAllDbs() {
    const dbNames = Object.keys(this.APP.databases || {});
    const areAllExpanded = dbNames.length > 0 && dbNames.every(db => this.S.expandedDbs.has(db));
    if (areAllExpanded) {
        this.S.expandedDbs.clear();
    } else {
        dbNames.forEach(db => this.S.expandedDbs.add(db));
    }
    this.saveLocalState();
    this.renderSidebar();
}

export async function refreshSidebar(btn) {
    if (btn) btn.classList.add('spinning');
    try {
        await this.loadDatabasesFromServer();
        this.showMsg("Databases and tables refreshed", "success");
    } catch (e) {
        this.showMsg(e.message || "Failed to refresh databases", "error");
    } finally {
        if (btn) btn.classList.remove('spinning');
    }
}

export function startSidebarResize(e) {
    e.preventDefault();
    const resizer = document.getElementById('sidebar-resizer');
    if (resizer) resizer.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent) => {
        const newWidth = Math.min(500, Math.max(180, moveEvent.clientX));
        document.documentElement.style.setProperty('--sidebar-w', `${newWidth}px`);
        localStorage.setItem('dbm_sidebar_w', `${newWidth}px`);
    };

    const onMouseUp = () => {
        if (resizer) resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

export function showTab(tab) {
    this.S.tab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + tab)?.classList.add('active');

    if (tab === 'export') {
        if (!this.S.exportScope) {
            this.S.exportScope = this.S.table ? 'table' : 'database';
        }
        if (this.S.db && this.S.exportInfoDb !== this.S.db) {
            // The cached table list belongs to another database (or is stale).
            this.S.exportTablesInfo = [];
            this.S.exportTables = new Set();
        }
        if (this.S.db && (!this.S.exportTablesInfo || this.S.exportTablesInfo.length === 0)) {
            this.loadExportTablesInfo();
        }
    } else if (tab === 'import') {
        if (!this.S.importTargetTable && this.S.table) {
            this.S.importTargetTable = this.S.table;
        }
    }

    this.saveLocalState();

    // The Objects view drops cached rows after emptying / renaming a table, so
    // fetch them again instead of rendering an empty grid.
    if ((tab === 'browse' || tab === 'structure') && this.S.db && this.S.table && !this.APP.tableData[this.S.table]) {
        this.loadTableDataFromServer(this.S.db, this.S.table);
        return;
    }
    this.renderPanel();
}

// ─── STRUCTURE CONTROL LOGIC ───────────────────────────────

/** Add or edit a column. opts.after preselects "insert after that column" for a new one. */
export function openColumnEditor(colName = null, opts = {}) {
    const isEdit = !!colName;
    const headers = this.APP.colHeaders[this.S.table] || [];
    const schema = this.APP.schemas[this.S.table] || [];

    let c = { n: '', t: 'VARCHAR', len: '255', defType: 'NONE', defVal: '', collate: '', attr: '', null: false, ai: false, comment: '' };
    // The table's own collation (from the Structure overview), offered as the default.
    const tableColl = this.APP.structInfo?.[`${this.S.db}\u0000${this.S.table}`]?.status?.collation || '';

    if (isEdit) {
        const existing = schema.find(s => s.n === colName);
        if (existing) {
            const typeMatch = existing.t.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?/);
            c.n = existing.n;
            c.t = typeMatch ? typeMatch[1].toUpperCase() : 'VARCHAR';
            c.len = typeMatch && typeMatch[2] ? typeMatch[2] : '';

            c.null = !!existing.null;
            c.ai = (existing.extra || '').includes('auto_increment');
            c.comment = existing.comment || '';
            c.collate = existing.collate || '';
            c.attr = existing.t.includes('unsigned') ? 'UNSIGNED' : ((existing.extra || '').includes('on update') ? 'ON UPDATE CURRENT_TIMESTAMP' : '');

            if (existing.def === null && existing.null) c.defType = 'NULL';
            else if (existing.def === 'CURRENT_TIMESTAMP') c.defType = 'CURRENT_TIMESTAMP';
            else if (existing.def !== null) { c.defType = 'USER_DEFINED'; c.defVal = existing.def; }
        }
    }

    const datatypes = {
        "Frequently Used": ["INT", "VARCHAR", "TEXT", "DATE"],
        "Numeric": ["TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT", "DECIMAL", "FLOAT", "DOUBLE", "REAL", "BIT", "BOOLEAN"],
        "Date and time": ["DATETIME", "TIMESTAMP", "TIME", "YEAR"],
        "String": ["CHAR", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT", "BINARY", "VARBINARY", "TINYBLOB", "BLOB", "LONGBLOB", "ENUM", "SET"],
        "Spatial": ["GEOMETRY", "POINT", "LINESTRING", "POLYGON"],
        "JSON": ["JSON"]
    };

    let selectedSet = false;
    const typeOptionsHtml = Object.entries(datatypes).map(([group, types]) => `
        <optgroup label="${group}">
            ${types.map(t => {
        const isSel = (!selectedSet && c.t === t);
        if (isSel) selectedSet = true;
        return `<option value="${t}" ${isSel ? 'selected' : ''}>${t}</option>`;
    }).join('')}
        </optgroup>
    `).join('');

    const modalHtml = `
        <div id="col-modal-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter:blur(3px);">
            <div style="background:var(--bg1); border:1px solid var(--line2); color:var(--text0); border-radius:var(--radius-lg); padding:24px; width:700px; box-shadow:0 24px 64px rgba(0,0,0,0.6);">
                <div style="font-family:var(--font-display); font-size:16px; font-weight:700; margin-bottom:20px;">
                    ${isEdit ? `Edit Column: <span style="color:var(--accent)">${esc(colName)}</span>` : `<i class="ti ti-plus" aria-hidden="true"></i> Add Column to ${esc(this.S.table)}`}
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px;">
                    <div><label style="font-size:10px; color:var(--text2);">Name</label><input id="ce-name" class="search-input" style="width:100%" value="${esc(c.n)}" /></div>
                    
                    <div><label style="font-size:10px; color:var(--text2);">Type</label>
                     <select id="ce-type" class="search-input" style="width:100%" onchange="window._dbm.handleTypeChange(this.value)">
                        ${typeOptionsHtml}
                    </select>
                    </div>
                    
                    <div><label style="font-size:10px; color:var(--text2);">Length/Values</label>
                        <input id="ce-len" class="search-input" style="width:100%" value="${esc(c.len)}" placeholder="${c.t === 'ENUM' ? `&#39;val1&#39;,&#39;val2&#39;` : 'e.g. 255 or 10,2'}" />
                    </div>
                    
                    <div><label style="font-size:10px; color:var(--text2);">Default</label>
                        <select id="ce-def-type" class="search-input" style="width:100%" onchange="document.getElementById('ce-def-val').style.display = this.value === 'USER_DEFINED' ? 'block' : 'none'">
                            <option value="NONE" ${c.defType === 'NONE' ? 'selected' : ''}>None</option>
                            <option value="USER_DEFINED" ${c.defType === 'USER_DEFINED' ? 'selected' : ''}>As defined:</option>
                            <option value="NULL" ${c.defType === 'NULL' ? 'selected' : ''}>NULL</option>
                            <option value="CURRENT_TIMESTAMP" ${c.defType === 'CURRENT_TIMESTAMP' ? 'selected' : ''}>CURRENT_TIMESTAMP</option>
                        </select>
                        <input id="ce-def-val" class="search-input" style="width:100%; margin-top:6px; display:${c.defType === 'USER_DEFINED' ? 'block' : 'none'}" value="${esc(c.defVal)}" placeholder="Default value" />
                    </div>

                    <div><label style="font-size:10px; color:var(--text2);">Collation</label>
                        <input id="ce-collate" class="search-input" style="width:100%" list="ce-collate-list" autocomplete="off" spellcheck="false"
                               value="${esc(c.collate)}" placeholder="${esc(tableColl ? `table default (${tableColl})` : 'table default')}" />
                        <datalist id="ce-collate-list">
                            ${[...new Set([c.collate, tableColl,'utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_bin', 'utf8mb3_general_ci', 'utf8mb3_unicode_ci', 'latin1_swedish_ci'].filter(Boolean))].map(v => `<option value="${esc(v)}"></option>`).join('')}
                        </datalist>
                    </div>

                    <div><label style="font-size:10px; color:var(--text2);">Attributes</label>
                        <select id="ce-attr" class="search-input" style="width:100%">
                            <option value=""></option>
                            <option value="UNSIGNED" ${c.attr === 'UNSIGNED' ? 'selected' : ''}>UNSIGNED</option>
                            <option value="ON UPDATE CURRENT_TIMESTAMP" ${c.attr === 'ON UPDATE CURRENT_TIMESTAMP' ? 'selected' : ''}>on update CURRENT_TIMESTAMP</option>
                        </select>
                    </div>

                    <div style="display:flex; gap:16px; align-items:center; margin-top:16px;">
                        <label style="display:flex; align-items:center; gap:6px; color:var(--text0); font-size:11px; cursor:pointer;">
                            <input type="checkbox" id="ce-null" ${c.null ? 'checked' : ''} style="accent-color:var(--accent)" /> Allow NULL
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; color:var(--text0); font-size:11px; cursor:pointer;" title="Auto Increment">
                            <input type="checkbox" id="ce-ai" ${c.ai ? 'checked' : ''} style="accent-color:var(--accent)" /> A_I
                        </label>
                    </div>

                    <div style="grid-column: span 2;"><label style="font-size:10px; color:var(--text2);">Comments</label><input id="ce-comment" class="search-input" style="width:100%" value="${esc(c.comment)}" placeholder="Internal comment" /></div>
                </div>

                <div style="margin-top:16px;">
                    <label style="font-size:10px; color:var(--text2);">Move Column To:</label>
                    <select id="ce-position" class="search-input" style="width:100%; max-width:220px; display:block; margin-top:4px;">
                        <option value="">Do not move</option>
                        <option value="FIRST">At Beginning (FIRST)</option>
                        ${headers.map(h => `<option value="${esc('AFTER `' + String(h).replace(/`/g, '``') + '`')}" ${opts.after === h ? 'selected' : ''}>After ${esc(h)}</option>`).join('')}
                    </select>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:24px; border-top:1px solid var(--line); padding-top:16px;">
                    <button class="btn" onclick="document.getElementById('col-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitColumnEditor(${isEdit}, ${isEdit ? `'${escJs(colName)}'` : 'null'})">Save Changes</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function handleTypeChange(type) {
    const lenInput = document.getElementById('ce-len');
    if (!lenInput) return;

    if (type === 'ENUM' || type === 'SET') {
        lenInput.placeholder = "'val1','val2'...";
    } else if (['VARCHAR', 'CHAR', 'BIT'].includes(type)) {
        lenInput.placeholder = "255";
    } else if (type === 'DECIMAL' || type === 'FLOAT') {
        lenInput.placeholder = "10,2";
    } else {
        lenInput.placeholder = "";
    }
}

export async function submitColumnEditor(isEdit, oldName) {
    const colName = document.getElementById('ce-name')?.value.trim();
    if (!colName) return this.showMsg("Column name is required", "error");

    const payload = {
        db: this.S.db,
        table: this.S.table,
        is_edit: isEdit,
        old_name: oldName,
        col_name: colName,
        col_type: document.getElementById('ce-type').value,
        col_length: document.getElementById('ce-len').value.trim(),
        def_type: document.getElementById('ce-def-type').value,
        def_val: document.getElementById('ce-def-val').value.trim(),
        col_collation: document.getElementById('ce-collate').value,
        col_attr: document.getElementById('ce-attr').value,
        is_null: document.getElementById('ce-null').checked,
        is_ai: document.getElementById('ce-ai').checked,
        col_comment: document.getElementById('ce-comment').value.trim(),
        col_position: document.getElementById('ce-position').value
    };

    try {
        const res = await fetch(`${this.apiUrl}?action=save_column`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save column');

        const modal = document.getElementById('col-modal-overlay');
        if (modal) modal.remove();

        this.showMsg(`Column successfully ${isEdit ? 'updated' : 'added'}.`);
        await this.loadTableDataFromServer(this.S.db, this.S.table);
        await this.loadIndexes();
    } catch (err) {
        this.showMsg(err.message, "error");
    }
}

export async function dropColumn(colName) {
    this.showConfirmDialog(
        "Drop Column",
        `Are you sure you want to DROP the column "${colName}"? All data in this column will be permanently lost.`,
        async () => {
            try {
                const res = await fetch(`${this.apiUrl}?action=drop_column`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        db: this.S.db,
                        table: this.S.table,
                        col_name: colName
                    })
                });

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to drop column');

                this.showMsg(`Column "${colName}" was removed successfully.`);
                await this.loadTableDataFromServer(this.S.db, this.S.table);
                await this.loadIndexes();

            } catch (err) {
                this.showMsg(err.message, "error");
            }
        },
        { confirmText: "Drop Column", cancelText: "Cancel", type: "danger" }
    );
}

export async function addIndex(colName, type) {
    this.showConfirmDialog(
        "Add Index",
        `Add a ${type} index to column "${colName}"?`,
        async () => {
            try {
                const res = await fetch(`${this.apiUrl}?action=add_index`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ db: this.S.db, table: this.S.table, col_name: colName, index_type: type })
                });

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add index');

                this.showMsg(`Added ${type} index to ${colName}.`);
                await this.loadTableDataFromServer(this.S.db, this.S.table);
                await this.loadIndexes();
            } catch (err) {
                this.showMsg(err.message, "error");
            }
        },
        { confirmText: "Add Index", cancelText: "Cancel", type: "primary" }
    );
}

export async function loadIndexes() {
    const key = `${this.S.db}\u0000${this.S.table}`;
    if (this._indexesLoading === key) return; // the render loop calls this until it arrives
    this._indexesLoading = key;
    try {
        const res = await fetch(`${this.apiUrl}?action=get_indexes&db=${encodeURIComponent(this.S.db)}&table=${encodeURIComponent(this.S.table)}`);
        const data = await res.json();
        if (key !== `${this.S.db}\u0000${this.S.table}`) return; // switched tables meanwhile
        this.S.currentIndexes = data.indexes || [];
    } catch (e) {
        this.S.currentIndexes = [];
    } finally {
        if (this._indexesLoading === key) this._indexesLoading = null;
    }
    this.renderPanel();
}

export async function dropIndex(keyName) {
    this.showConfirmDialog(
        "Drop Index",
        `Are you sure you want to drop index "${keyName}"? This action cannot be undone.`,
        async () => {
            try {
                const res = await fetch(`${this.apiUrl}?action=drop_index`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ db: this.S.db, table: this.S.table, key_name: keyName })
                });

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to drop index');

                this.showMsg(`Index '${keyName}' dropped.`);
                await this.loadTableDataFromServer(this.S.db, this.S.table);
                await this.loadIndexes();
            } catch (err) {
                this.showMsg(err.message, "error");
            }
        },
        { confirmText: "Drop Index", cancelText: "Cancel", type: "danger" }
    );
}

export function filterStructureTable(query) {
    const q = (query || '').toLowerCase().trim();
    const rows = document.querySelectorAll('#struct-table-body tr.struct-col-row');
    const clearBtn = document.getElementById('struct-col-clear');
    if (clearBtn) {
        clearBtn.style.display = q ? 'inline-flex' : 'none';
    }
    let visibleCount = 0;
    rows.forEach(r => {
        const name = r.getAttribute('data-col-name') || '';
        const type = r.getAttribute('data-col-type') || '';
        const match = !q || name.includes(q) || type.includes(q);
        r.style.display = match ? '' : 'none';
        if (match) visibleCount++;
    });
    const noMatchRow = document.getElementById('struct-no-match-row');
    if (noMatchRow) {
        noMatchRow.style.display = (visibleCount === 0 && rows.length > 0) ? '' : 'none';
    }
}

export function clearStructureSearch() {
    const inp = document.getElementById('struct-col-search');
    if (inp) inp.value = '';
    this.filterStructureTable('');
}

export function openAddIndexModal() {
    const headers = this.APP.colHeaders[this.S.table] || [];
    const schema = this.APP.schemas[this.S.table] || [];
    const modalHtml = `
        <div id="index-modal-overlay" class="modal-overlay">
            <div class="modal-card" style="width:460px;">
                <div class="modal-header">
                    <div class="modal-title"><i class="ti ti-plus" aria-hidden="true"></i> Add New Index</div>
                    <button class="modal-close-btn" onclick="document.getElementById('index-modal-overlay').remove()"><i class="ti ti-x" aria-hidden="true"></i></button>
                </div>
                <div style="display:flex; flex-direction:column; gap:14px; margin-top:14px;">
                    <div>
                        <label class="modal-label">Index Name <span style="color:var(--text3); font-weight:normal;">(Optional - auto-generated if blank)</span></label>
                        <input id="idx-name" class="search-input" style="width:100%" placeholder="e.g. idx_user_status" />
                    </div>
                    <div>
                        <label class="modal-label">Index Type</label>
                        <select id="idx-type" class="search-input" style="width:100%">
                            <option value="INDEX">INDEX (Standard B-Tree Index)</option>
                            <option value="UNIQUE">UNIQUE (Enforce unique values)</option>
                            <option value="PRIMARY">PRIMARY KEY</option>
                        </select>
                    </div>
                    <div>
                        <label class="modal-label">Indexed Column(s) <span style="color:var(--text3); font-weight:normal;">(Select one or more for composite index)</span></label>
                        <div id="idx-cols-list" class="modal-cols-selector">
                            ${headers.map((h, i) => {
                                const colInfo = schema.find(s => s.n === h);
                                const typeStr = colInfo ? colInfo.t : '';
                                return `
                                    <label class="modal-col-item">
                                        <input type="checkbox" value="${esc(h)}" ${i === 0 ? 'checked' : ''} />
                                        <span class="modal-col-name">${esc(h)}</span>
                                        ${typeStr ? `<span class="modal-col-type">${esc(typeStr)}</span>` : ''}
                                    </label>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="document.getElementById('index-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitIndex()">Create Index</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export async function submitIndex() {
    const type = document.getElementById('idx-type')?.value || 'INDEX';
    const indexName = document.getElementById('idx-name')?.value.trim() || '';

    const selectedCols = Array.from(document.querySelectorAll('#idx-cols-list input[type="checkbox"]:checked')).map(cb => cb.value);
    if (selectedCols.length === 0) {
        return this.showMsg("Please select at least one column for the index.", "error");
    }

    try {
        const res = await fetch(`${this.apiUrl}?action=add_index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                db: this.S.db,
                table: this.S.table,
                cols: selectedCols,
                col_name: selectedCols.join(','),
                index_type: type,
                index_name: indexName
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add index');

        const modal = document.getElementById('index-modal-overlay');
        if (modal) modal.remove();

        this.showMsg(`Index (${type}) on [${selectedCols.join(', ')}] created successfully.`);
        await this.loadTableDataFromServer(this.S.db, this.S.table);
        await this.loadIndexes();

    } catch (err) {
        this.showMsg(err.message, "error");
    }
}

export function openEditIndexModal(keyName) {
    const rawIndexes = this.S.currentIndexes || [];
    const matchingRows = rawIndexes.filter(i => i.Key_name === keyName);
    if (matchingRows.length === 0) return;

    const first = matchingRows[0];
    const existingCols = matchingRows.map(i => i.Column_name);
    const headers = this.APP.colHeaders[this.S.table] || [];
    const schema = this.APP.schemas[this.S.table] || [];

    let currentType = 'INDEX';
    if (first.Key_name === 'PRIMARY') currentType = 'PRIMARY';
    else if (String(first.Non_unique) === '0') currentType = 'UNIQUE';

    const modalHtml = `
        <div id="index-modal-overlay" class="modal-overlay">
            <div class="modal-card" style="width:460px;">
                <div class="modal-header">
                    <div class="modal-title"><i class="ti ti-pencil" aria-hidden="true"></i> Edit Index: <span style="color:var(--accent); font-family:var(--font-mono);">${esc(keyName)}</span></div>
                    <button class="modal-close-btn" onclick="document.getElementById('index-modal-overlay').remove()"><i class="ti ti-x" aria-hidden="true"></i></button>
                </div>
                <div style="display:flex; flex-direction:column; gap:14px; margin-top:14px;">
                    <div>
                        <label class="modal-label">Index Name</label>
                        <input id="edit-idx-name" class="search-input" style="width:100%"
                               value="${first.Key_name === 'PRIMARY' ? 'PRIMARY' : esc(first.Key_name)}"
                               ${first.Key_name === 'PRIMARY' ? 'disabled title="Cannot rename PRIMARY KEY"' : ''}
                               placeholder="e.g. idx_user_status" />
                    </div>
                    <div>
                        <label class="modal-label">Index Type</label>
                        <select id="edit-idx-type" class="search-input" style="width:100%" ${first.Key_name === 'PRIMARY' ? 'disabled' : ''}>
                            <option value="INDEX" ${currentType === 'INDEX' ? 'selected' : ''}>INDEX (Standard B-Tree Index)</option>
                            <option value="UNIQUE" ${currentType === 'UNIQUE' ? 'selected' : ''}>UNIQUE (Enforce unique values)</option>
                            <option value="PRIMARY" ${currentType === 'PRIMARY' ? 'selected' : ''}>PRIMARY KEY</option>
                        </select>
                    </div>
                    <div>
                        <label class="modal-label">Indexed Column(s) <span style="color:var(--text3); font-weight:normal;">(Select one or more for composite index)</span></label>
                        <div id="edit-idx-cols-list" class="modal-cols-selector">
                            ${headers.map(h => {
                                const isChecked = existingCols.includes(h);
                                const colInfo = schema.find(s => s.n === h);
                                const typeStr = colInfo ? colInfo.t : '';
                                return `
                                    <label class="modal-col-item">
                                        <input type="checkbox" value="${esc(h)}" ${isChecked ? 'checked' : ''} />
                                        <span class="modal-col-name">${esc(h)}</span>
                                        ${typeStr ? `<span class="modal-col-type">${esc(typeStr)}</span>` : ''}
                                    </label>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="document.getElementById('index-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitEditIndex('${escJs(keyName)}')">Save Changes</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export async function submitEditIndex(oldKeyName) {
    const nameEl = document.getElementById('edit-idx-name');
    const newName = nameEl ? nameEl.value.trim() : '';
    const typeSelect = document.getElementById('edit-idx-type');
    const type = (oldKeyName === 'PRIMARY' || !typeSelect) ? 'PRIMARY' : typeSelect.value;

    const selectedCols = Array.from(document.querySelectorAll('#edit-idx-cols-list input[type="checkbox"]:checked')).map(cb => cb.value);
    if (selectedCols.length === 0) {
        return this.showMsg("Please select at least one column for the index.", "error");
    }

    try {
        const res = await fetch(`${this.apiUrl}?action=edit_index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                db: this.S.db,
                table: this.S.table,
                old_key_name: oldKeyName,
                new_key_name: newName,
                cols: selectedCols,
                col_name: selectedCols.join(','),
                index_type: type
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to edit index');

        const modal = document.getElementById('index-modal-overlay');
        if (modal) modal.remove();

        this.showMsg(`Index '${oldKeyName}' updated successfully.`);
        await this.loadTableDataFromServer(this.S.db, this.S.table);
        await this.loadIndexes();

    } catch (err) {
        this.showMsg(err.message, "error");
    }
}

export function toggleSidebar() {
    this.setSidebarOpen(!this.S.sidebarOpen);
}

/**
 * Open or close the sidebar with a slide (CSS does the animation). On phones it
 * is a drawer over a fading backdrop. While closed it is `inert`, so Tab can't
 * reach hidden links. Only the desktop choice is remembered: phones always start
 * with it closed.
 */
export function setSidebarOpen(open) {
    this.S.sidebarOpen = !!open;
    if (window.innerWidth > 768) {
        this.S.sidebarDesktopPref = this.S.sidebarOpen;
        this.saveLocalState();
    }
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) {
        sidebar.classList.toggle('is-closed', !this.S.sidebarOpen);
        sidebar.toggleAttribute('inert', !this.S.sidebarOpen);
    }
    if (backdrop) backdrop.classList.toggle('is-open', this.S.sidebarOpen && window.innerWidth <= 768);
}

export function toggleTheme() {
    this.S.theme = this.S.theme === 'dark' ? 'light' : 'dark';
    this.saveLocalState();

    if (this.S.theme === 'light') document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');

    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.innerHTML = this.S.theme === 'dark'
            ? '<i class="ti ti-moon" aria-hidden="true" style="font-size:16px"></i>'
            : '<i class="ti ti-sun" aria-hidden="true" style="font-size:16px"></i>';
    }

    if (this.editor) this.editor.setOption("theme", this.S.theme === 'dark' ? 'dracula' : 'default');
}

export function toggleTerminal(forceOpen = null) {
    this.S.terminalOpen = forceOpen !== null ? forceOpen : !this.S.terminalOpen;
    this.saveLocalState();

    const wrapper = document.getElementById('terminal-wrapper');
    const body = document.getElementById('term-body');
    const btn = document.getElementById('term-toggle-btn');
    const height = this.S.terminalHeight || 180;

    if (wrapper && body && btn) {
        wrapper.classList.toggle('is-open', this.S.terminalOpen);
        if (this.S.terminalOpen) {
            wrapper.style.height = `${height}px`;
            body.style.display = 'block';
            btn.innerHTML = '<i class="ti ti-chevron-down" aria-hidden="true"></i>';
        } else {
            wrapper.style.height = '34px';
            body.style.display = 'none';
            btn.innerHTML = '<i class="ti ti-chevron-up" aria-hidden="true"></i>';
        }
    }
}

export function startTerminalResize(e) {
    e.preventDefault();
    const resizer = document.getElementById('term-resizer');
    const wrapper = document.getElementById('terminal-wrapper');
    const body = document.getElementById('term-body');
    const btn = document.getElementById('term-toggle-btn');
    if (!wrapper) return;

    if (resizer) resizer.classList.add('resizing');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = wrapper.offsetHeight;

    const onMouseMove = (moveEvent) => {
        const delta = startY - moveEvent.clientY;
        const newHeight = Math.min(window.innerHeight - 120, Math.max(70, startHeight + delta));
        wrapper.style.height = `${newHeight}px`;
        this.S.terminalHeight = newHeight;
        this.S.terminalOpen = true;
        wrapper.classList.add('is-open');
        if (body) body.style.display = 'block';
        if (btn) btn.innerHTML = '<i class="ti ti-chevron-down" aria-hidden="true"></i>';
        localStorage.setItem('dbm_term_h', newHeight);
    };

    const onMouseUp = () => {
        if (resizer) resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        this.saveLocalState();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

export function copyAllLogs() {
    const logs = this.S.logs || [];
    if (logs.length === 0) return this.showMsg("No logs to copy", "info");
    const text = logs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.msg}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        this.showMsg("Copied all logs to clipboard", "success");
    });
}

export function copySingleLog(msg) {
    navigator.clipboard.writeText(msg).then(() => {
        this.showMsg("Copied log message to clipboard", "success");
    });
}

export function initResize(e, resizer) {
    e.stopPropagation();
    e.preventDefault();

    const th = resizer.parentElement;
    const startX = e.pageX;
    const startWidth = th.offsetWidth;
    const table = th.closest('table');

    if (table && table.style.tableLayout !== 'fixed') {
        const allHeaders = table.querySelectorAll('th');
        allHeaders.forEach(h => h.style.width = h.offsetWidth + 'px');
        table.style.tableLayout = 'fixed';
        table.style.width = 'max-content';
    }

    resizer.classList.add('resizing');

    const onMouseMove = (moveEvent) => {
        requestAnimationFrame(() => {
            const newWidth = Math.max(30, startWidth + (moveEvent.pageX - startX));
            th.style.width = newWidth + 'px';
            th.style.minWidth = newWidth + 'px';
            th.style.maxWidth = newWidth + 'px';
        });
    };

    const onMouseUp = () => {
        resizer.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

export function saveLocalState() {
    try {
        localStorage.setItem('dbm_state', JSON.stringify({
            db: this.S.db,
            table: this.S.table,
            tab: this.S.tab,
            // The desktop choice only; phones always start with the sidebar closed.
            sidebarOpen: this.S.sidebarDesktopPref !== false,
            terminalOpen: this.S.terminalOpen,
            perPage: this.S.perPage || 25,
            theme: this.S.theme,
            logs: this.S.logs || [],
            colFilters: this.S.colFilters || {},
            showFilterRow: this.S.showFilterRow !== false,
            objSort: this.S.objSort,
            exportGzip: this.S.exportGzip !== false
        }));
        localStorage.setItem('dbm_expanded', JSON.stringify([...(this.S.expandedDbs || [])]));
    } catch (e) {
        console.error("Failed to save local state:", e);
    }
}

// ─── EXPORT & IMPORT ACTIONS ────────────────────────────────

export async function loadExportTablesInfo() {
    if (!this.S.db) return;
    const db = this.S.db;
    try {
        const tables = await this.fetchTablesStatus(db);
        if (db !== this.S.db) return; // the user switched databases meanwhile
        this.S.exportTablesInfo = tables || [];
        this.S.exportInfoDb = db;
        if (!this.S.exportTables || this.S.exportTables.size === 0) {
            this.S.exportTables = new Set(this.S.exportTablesInfo.map(t => t.name));
        }
        if (this.S.tab === 'export') {
            this.renderPanel();
        }
    } catch (err) {
        console.error("Failed to load table status for export:", err);
    }
}

export function setExportScope(scope) {
    this.S.exportScope = scope;
    if (scope === 'database' && (!this.S.exportTablesInfo || this.S.exportTablesInfo.length === 0)) {
        this.loadExportTablesInfo();
    }
    this.renderPanel();
}

export function setExportFormat(fmt) {
    this.S.exportFormat = fmt;
    this.renderPanel();
}

export function setExportType(type) {
    this.S.exportType = type;
    this.renderPanel();
}

export function toggleExportTable(tableName) {
    if (!this.S.exportTables) this.S.exportTables = new Set();
    if (this.S.exportTables.has(tableName)) {
        this.S.exportTables.delete(tableName);
    } else {
        this.S.exportTables.add(tableName);
    }
    this.renderPanel();
}

export function toggleAllExportTables(selectAll) {
    if (!this.S.exportTables) this.S.exportTables = new Set();
    if (selectAll) {
        const list = this.S.exportTablesInfo?.length 
            ? this.S.exportTablesInfo.map(t => t.name) 
            : (this.APP.databases[this.S.db]?.tables || []);
        list.forEach(t => this.S.exportTables.add(t));
    } else {
        this.S.exportTables.clear();
    }
    this.renderPanel();
}

export function onExportSearch(val) {
    this.S.exportSearchFilter = val || '';
    const container = document.getElementById('ei-table-picker-list');
    if (!container) return;
    const filter = (val || '').toLowerCase().trim();
    container.querySelectorAll('.ei-table-row').forEach(row => {
        const name = row.getAttribute('data-table') || '';
        row.style.display = (!filter || name.toLowerCase().includes(filter)) ? '' : 'none';
    });
}

export function toggleExportOption(optName) {
    if (optName === 'dropTable') this.S.exportDropTable = !this.S.exportDropTable;
    else if (optName === 'createDb') this.S.exportCreateDb = !this.S.exportCreateDb;
    else if (optName === 'disableFk') this.S.exportDisableFk = !this.S.exportDisableFk;
    else if (optName === 'routines') this.S.exportRoutines = !this.S.exportRoutines;
    else if (optName === 'keepDefiner') this.S.exportKeepDefiner = !this.S.exportKeepDefiner;
    else if (optName === 'gzip') { this.S.exportGzip = !this.S.exportGzip; this.saveLocalState(); }
    this.renderPanel();
}

/**
 * Let the browser download a URL itself (saved straight to disk with its own
 * progress, so files of any size work) from a hidden frame. Resolves once the
 * server's "download started" cookie (dbm_dl=<token>) appears; rejects with the
 * server's message if the frame shows an error page instead of a file.
 */
function downloadInFrame(url, token) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.setAttribute('aria-hidden', 'true');
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            clearInterval(poll);
            clearTimeout(giveUp);
            document.cookie = 'dbm_dl=; Max-Age=0; path=/';
            // Keep the frame a little longer: removing it can cancel a download that is just starting.
            setTimeout(() => frame.remove(), err ? 0 : 60000);
            if (err) reject(err); else resolve();
        };
        const poll = setInterval(() => {
            if (document.cookie.split('; ').includes(`dbm_dl=${token}`)) finish();
        }, 300);
        // A file download never fires "load"; an error page (JSON) does.
        frame.addEventListener('load', () => {
            let text = '';
            try { text = frame.contentDocument?.body?.textContent || ''; } catch (e) { /* not readable */ }
            let msg = '';
            try { msg = JSON.parse(text).error || ''; } catch (e) { msg = text.trim().slice(0, 300); }
            finish(new Error(msg || 'The export failed on the server (no details). Check the PHP error log.'));
        });
        // Slow servers: stop waiting for the cookie, the download may still arrive.
        const giveUp = setTimeout(() => finish(), 120000);
        frame.src = url;
        document.body.appendChild(frame);
    });
}

export async function executeExport(isDirectDownload = true) {
    if (!this.S.db) {
        return this.showMsg("Please select a database first.", "error");
    }

    const isTableScope = this.S.exportScope === 'table' && this.S.table;
    const selectedTables = isTableScope ? [this.S.table] : Array.from(this.S.exportTables || []);

    if (!isTableScope && selectedTables.length === 0) {
        return this.showMsg("Please select at least one table to export.", "error");
    }

    const params = {
        db: this.S.db,
        table: isTableScope ? this.S.table : '',
        tables: isTableScope ? '' : selectedTables,
        format: this.S.exportFormat || 'sql',
        export_type: this.S.exportType || 'all',
        add_drop_table: this.S.exportDropTable ? 1 : 0,
        add_create_db: this.S.exportCreateDb ? 1 : 0,
        disable_fk: this.S.exportDisableFk ? 1 : 0,
        include_routines: this.S.exportRoutines ? 1 : 0,
        keep_definer: this.S.exportKeepDefiner ? 1 : 0
    };

    this.S.exportLoading = true;
    this.renderPanel();

    if (isDirectDownload) {
        // Every table ticked → let the server list them (keeps the address short for big databases).
        const allTicked = !isTableScope && (this.S.exportTablesInfo || []).length > 0
            && selectedTables.length === this.S.exportTablesInfo.length;
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        try {
            const queryParams = new URLSearchParams({
                action: 'export',
                download: '1',
                token,
                db: params.db,
                table: params.table,
                tables: allTicked ? '' : JSON.stringify(params.tables),
                format: params.format,
                export_type: params.export_type,
                add_drop_table: params.add_drop_table,
                add_create_db: params.add_create_db,
                disable_fk: params.disable_fk,
                include_routines: params.include_routines,
                keep_definer: params.keep_definer,
                compress: this.S.exportGzip ? 'gzip' : ''
            });

            await downloadInFrame(`${this.apiUrl}?${queryParams.toString()}`, token);
            this.showMsg(`Export of ${isTableScope ? params.table : `${selectedTables.length} tables`} started. Your browser is saving the file (see its downloads).`);
        } catch (err) {
            this.showMsg(err.message, "error");
        } finally {
            this.S.exportLoading = false;
            this.renderPanel();
        }
    } else {
        try {
            const data = await this.requestExport(params);
            if (data && data.success) {
                this.openExportPreviewModal(data.filename, data.content, params.format);
            }
        } catch (err) {
            this.showMsg(err.message, "error");
        } finally {
            this.S.exportLoading = false;
            this.renderPanel();
        }
    }
}

export function openExportPreviewModal(filename, content, format) {
    const existing = document.getElementById('export-preview-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'export-preview-modal-overlay';
    overlay.style.cssText = `position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:10000; backdrop-filter:blur(4px); animation:fadeIn 0.15s ease;`;

    overlay.innerHTML = `
        <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); width:780px; max-width:94vw; max-height:88vh; display:flex; flex-direction:column; box-shadow:0 24px 64px rgba(0,0,0,0.5); overflow:hidden;">
            <div style="padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; background:var(--bg2);">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-family:var(--font-display); font-weight:700; font-size:14px; color:var(--text0);">Export Preview: ${esc(filename)}</span>
                    <span class="ei-meta-pill" style="text-transform:uppercase;">${esc(format)}</span>
                </div>
                <button onclick="window._dbm.closeExportPreviewModal()" style="border:none; background:transparent; color:var(--text2); font-size:16px; cursor:pointer; padding:4px 8px; border-radius:4px;"><i class="ti ti-x" aria-hidden="true"></i></button>
            </div>
            <div style="flex:1; overflow:auto; padding:16px; background:var(--bg0);">
                <pre style="margin:0; font-family:var(--font-mono); font-size:11px; line-height:1.5; color:var(--text0); white-space:pre-wrap; word-break:break-all;" id="export-preview-text">${esc(content)}</pre>
            </div>
            <div style="padding:12px 20px; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; background:var(--bg2);">
                <div style="font-size:11px; color:var(--text2); font-family:var(--font-mono);">
                    Size: ${formatBytes(content.length)}
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn" onclick="window._dbm.copyExportPreviewContent()"><i class="ti ti-clipboard" aria-hidden="true"></i> Copy to Clipboard</button>
                    <button class="btn primary" onclick="window._dbm.downloadExportPreview('${escJs(filename)}')"><i class="ti ti-download" aria-hidden="true"></i> Download File</button>
                    <button class="btn" onclick="window._dbm.closeExportPreviewModal()">Close</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    this._exportPreviewContent = content;
}

export function closeExportPreviewModal() {
    const el = document.getElementById('export-preview-modal-overlay');
    if (el) el.remove();
}

export function copyExportPreviewContent() {
    if (this._exportPreviewContent) {
        navigator.clipboard.writeText(this._exportPreviewContent).then(() => {
            this.showMsg("Export content copied to clipboard!");
        }).catch(() => {
            this.showMsg("Failed to copy content to clipboard", "error");
        });
    }
}

export function downloadExportPreview(filename) {
    if (this._exportPreviewContent) {
        downloadFile(filename, this._exportPreviewContent);
        this.showMsg(`Downloaded ${filename}`);
        this.closeExportPreviewModal();
    }
}

// ─── IMPORT ACTIONS ─────────────────────────────────────────

export function handleImportFileSelect(e) {
    const file = e.target.files?.[0];
    if (file) {
        this.processImportFile(file);
    }
}

export function handleImportDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropzone = document.getElementById('ei-dropzone-box');
    if (dropzone) dropzone.classList.add('dragover');
}

export function handleImportDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropzone = document.getElementById('ei-dropzone-box');
    if (dropzone) dropzone.classList.remove('dragover');
}

export function handleImportDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropzone = document.getElementById('ei-dropzone-box');
    if (dropzone) dropzone.classList.remove('dragover');

    const file = e.dataTransfer?.files?.[0];
    if (file) {
        this.processImportFile(file);
    }
}

export function processImportFile(file) {
    this.S.importFile = file;
    this.S.importRawData = '';
    this.S.importResult = null;

    // Detect format ("x.sql.gz" counts as SQL; the server unpacks .gz)
    const ext = file.name.toLowerCase().replace(/\.gz$/, '').split('.').pop();
    if (['sql', 'csv', 'json'].includes(ext)) {
        this.S.importFormat = ext;
    }

    this.renderPanel();
    this.previewImport();
}

export function removeImportFile() {
    this.S.importFile = null;
    this.S.importPreviewData = null;
    this.S.importResult = null;
    const inp = document.getElementById('import-file-input');
    if (inp) inp.value = '';
    this.renderPanel();
}

export function onImportRawDataInput(val) {
    this.S.importRawData = val || '';
    if (val && !this.S.importFile) {
        this.S.importFormat = 'sql';
    }
}

export function setImportFormat(fmt) {
    this.S.importFormat = fmt;
    this.renderPanel();
    if (this.S.importFile || this.S.importRawData) {
        this.previewImport();
    }
}

export function setImportTargetTable(t) {
    this.S.importTargetTable = t;
    this.renderPanel();
}

export function setImportMode(mode) {
    this.S.importMode = mode;
    this.renderPanel();
}

export function toggleImportOption(optName) {
    if (optName === 'disableFk') this.S.importDisableFk = !this.S.importDisableFk;
    else if (optName === 'continueOnError') this.S.importContinueOnError = !this.S.importContinueOnError;
    else if (optName === 'csvHeaders') this.S.importCsvHasHeaders = !this.S.importCsvHasHeaders;
    this.renderPanel();
}

export function setImportDelimiter(delim) {
    this.S.importCsvDelimiter = delim;
    this.renderPanel();
    if (this.S.importFile || this.S.importRawData) {
        this.previewImport();
    }
}

export async function previewImport() {
    if (!this.S.importFile && !this.S.importRawData) return;

    const formData = new FormData();
    if (this.S.importFile) {
        formData.append('file', this.S.importFile);
    } else {
        formData.append('raw_data', this.S.importRawData);
    }
    formData.append('format', this.S.importFormat === 'auto' ? '' : this.S.importFormat);
    formData.append('delimiter', this.S.importCsvDelimiter || ',');

    try {
        const data = await this.previewImportApi(formData);
        if (data && data.success) {
            this.S.importPreviewData = data;
            if (this.S.importFormat === 'auto' && data.format) {
                this.S.importFormat = data.format;
            }
            if (data.detected_delimiter && !this.S.importCsvDelimiter) {
                this.S.importCsvDelimiter = data.detected_delimiter;
            }
        }
    } catch (err) {
        console.error("Preview failed:", err);
    } finally {
        this.renderPanel();
    }
}

export async function executeImport() {
    if (!this.S.db) {
        return this.showMsg("Please select a target database first.", "error");
    }
    if (!this.S.importFile && !this.S.importRawData.trim()) {
        return this.showMsg("Please choose a file or paste SQL to import.", "error");
    }

    const effectiveFormat = this.S.importFormat === 'auto' 
        ? (this.S.importFile?.name.split('.').pop()?.toLowerCase() || 'sql') 
        : this.S.importFormat;

    const targetTable = this.S.importTargetTable || this.S.table;
    if ((effectiveFormat === 'csv' || effectiveFormat === 'json') && !targetTable && !this.S.importPreviewData?.is_db_export) {
        return this.showMsg("Please select a target table for CSV/JSON import.", "error");
    }

    const formData = new FormData();
    formData.append('db', this.S.db);
    formData.append('table', targetTable || '');
    formData.append('format', effectiveFormat);
    formData.append('disable_fk', this.S.importDisableFk ? '1' : '0');
    formData.append('continue_on_error', this.S.importContinueOnError ? '1' : '0');
    formData.append('has_headers', this.S.importCsvHasHeaders ? '1' : '0');
    formData.append('delimiter', this.S.importCsvDelimiter || ',');
    formData.append('mode', this.S.importMode || 'insert');

    if (this.S.importFile) {
        formData.append('file', this.S.importFile);
    } else {
        formData.append('raw_data', this.S.importRawData);
    }

    this.S.importLoading = true;
    this.S.importResult = null;
    this.renderPanel();

    try {
        const result = await this.runImportApi(formData);
        if (result) {
            this.S.importResult = result;
            if (result.success) {
                const countMsg = result.format === 'sql' 
                    ? `Executed ${result.queries_executed} queries (${result.rows_affected} rows affected) in ${result.time_ms}ms`
                    : `Imported ${result.rows_imported} rows in ${result.time_ms}ms`;
                this.showMsg(countMsg, "success");
            } else {
                this.showMsg(`Import completed with ${result.errors?.length || 1} errors.`, "error");
            }
        }
    } catch (err) {
        this.S.importResult = {
            success: false,
            errors: [{ error: err.message, query_index: 1, snippet: '' }]
        };
        this.showMsg(err.message, "error");
    } finally {
        this.S.importLoading = false;
        this.renderPanel();
    }
}

export function resetImport() {
    this.S.importFile = null;
    this.S.importRawData = '';
    this.S.importPreviewData = null;
    this.S.importResult = null;
    this.S.importLoading = false;
    const inp = document.getElementById('import-file-input');
    if (inp) inp.value = '';
    this.renderPanel();
}
