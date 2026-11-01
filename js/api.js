import { esc } from './util.js';

export async function doLogin() {
    const hostEl = document.getElementById('inp-host');
    const userEl = document.getElementById('inp-user');
    const passEl = document.getElementById('inp-pass');
    const dbEl = document.getElementById('inp-db');
    const remEl = document.getElementById('inp-remember');
    const btn = document.getElementById('btn-connect');
    const btnText = document.getElementById('btn-connect-text');

    const host = hostEl?.value.trim() || 'localhost:3306';
    const user = userEl?.value.trim() || 'root';
    const password = passEl?.value || '';
    const database = dbEl?.value.trim() || '';
    const remember = remEl?.checked ?? false;

    // Loading state
    if (btn) {
        btn.disabled = true;
        btn.classList.add('loading');
        if (btnText) {
            btnText.innerHTML = '<span class="spinner"></span> Connecting...';
        }
    }
    const inputs = document.querySelectorAll('#login-screen input');
    inputs.forEach(inp => inp.disabled = true);

    try {
        const res = await fetch(`${this.apiUrl}?action=connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, user, password, database })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Connection failed');

        // Keep the token in sync after the server rotates the session id on login.
        if (data.csrf) this.S.csrf = data.csrf;

        // Persist remembered credentials
        if (remember) {
            localStorage.setItem('dbm_saved_conn', JSON.stringify({ host, user, database }));
        } else {
            localStorage.removeItem('dbm_saved_conn');
        }
        this.S.rememberConn = remember;
        this.S.savedDb = remember ? database : '';

        this.S.user = user;
        this.S.host = host;
        this.S.isLoggedIn = true;

        this.renderShell();
        await this.loadDatabasesFromServer();
    } catch (error) {
        // Reset loading state on failure
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('loading');
            if (btnText) btnText.innerHTML = 'Connect <i class="ti ti-arrow-right" aria-hidden="true"></i>';
        }
        inputs.forEach(inp => inp.disabled = false);
        this.showAlertDialog("Connection Failed", error.message, "error");
    }
}

export async function doLogout() {
    try { await fetch(`${this.apiUrl}?action=logout`); } catch (e) { }
    this.S.isLoggedIn = false;
    this.S.db = '';
    this.S.table = '';
    this.S.selected.clear();
    this.APP.databases = {};

    const savedConn = JSON.parse(localStorage.getItem('dbm_saved_conn') || 'null');
    if (savedConn) {
        this.S.user = savedConn.user;
        this.S.host = savedConn.host;
        this.S.savedDb = savedConn.database || '';
        this.S.rememberConn = true;
    }

    this.renderShell();
}

export function handleSessionExpired() {
    this.S.isLoggedIn = false;
    this.S.db = '';
    this.S.table = '';
    this.S.selected.clear();
    this.APP.databases = {};

    const savedConn = JSON.parse(localStorage.getItem('dbm_saved_conn') || 'null');
    if (savedConn) {
        this.S.user = savedConn.user;
        this.S.host = savedConn.host;
        this.S.savedDb = savedConn.database || '';
        this.S.rememberConn = true;
    }

    this.renderShell();
    this.showAlertDialog("Session Expired", "Your session has expired. Please log in again.", "error");
}

export async function loadDatabasesFromServer() {
    try {
        const dbRes = await fetch(`${this.apiUrl}?action=databases`);
        if (dbRes.status === 401) {
            this.handleSessionExpired();
            return;
        }
        const dbData = await dbRes.json();
        if (!dbRes.ok || !dbData.databases) throw new Error(dbData.error || 'Failed to fetch databases');

        this.APP.databases = {};

        // Filter system databases
        const userDbs = dbData.databases.filter(
            dbName => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(dbName)
        );

        // Fetch tables for all user databases in parallel for fast loading
        const tableResults = await Promise.all(
            userDbs.map(async (dbName) => {
                try {
                    const tblRes = await fetch(`${this.apiUrl}?action=tables&db=${encodeURIComponent(dbName)}`);
                    const tblData = await tblRes.json();
                    return { dbName, tables: tblData.tables || [], views: tblData.views || [] };
                } catch (e) {
                    return { dbName, tables: [], views: [] };
                }
            })
        );

        tableResults.forEach(({ dbName, tables, views }) => {
            this.APP.databases[dbName] = { tables, views };
        });

        const dbNames = Object.keys(this.APP.databases);
        const firstDb = dbNames[0];

        // 1. Validate Saved State
        if (this.S.db && !this.APP.databases[this.S.db]) {
            this.S.db = '';
            this.S.table = '';
        } else if (this.S.db && this.S.table && !(this.APP.databases[this.S.db]?.tables || []).includes(this.S.table)) {
            this.S.table = '';
        }

        // 2. Default to first database if none selected
        if (firstDb && !this.S.db) {
            this.S.db = firstDb;
            this.S.table = this.APP.databases[firstDb].tables[0] || '';
            this.S.expandedDbs.add(firstDb);
        }

        if (this.S.db) this.S.expandedDbs.add(this.S.db);

        if (typeof this.saveLocalState === 'function') {
            this.saveLocalState();
        }

        // Draw the database tree first: if the remembered table fails to open
        // (e.g. a broken view), the sidebar must still be there to navigate away.
        this.renderSidebar();
        this.updateStatus();

        if (this.S.db && this.S.table) {
            await this.loadTableDataFromServer(this.S.db, this.S.table);
        } else {
            this.renderSidebar();
            this.renderPanel();
            this.updateStatus();
        }
    } catch (error) {
        console.error("loadDatabasesFromServer error:", error);
        this.showMsg(error.message, "error");
        this.renderSidebar();
        this.renderPanel();
    }
}

/**
 * Load a page of rows. opts.quiet skips the full-panel spinner (used by the
 * filter bar, so the bar and your cursor stay put; the grid just fades briefly).
 */
export async function loadTableDataFromServer(db, table, opts = {}) {
    if (!db || !table) return;

    // Clear selected rows when changing table or page
    this.S.selected.clear();

    const panel = document.getElementById('panel');
    if (panel && this.S.tab === 'browse' && opts.quiet) {
        panel.querySelector('.tbl-wrapper')?.classList.add('is-loading');
    } else if (panel && this.S.tab === 'browse') {
        panel.innerHTML = `
            <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:var(--text2); font-family:var(--font-mono);">
                <div class="spinner" style="width:24px; height:24px; border-width:3px; margin-bottom:16px;"></div>
                <div>Fetching data for <span style="color:var(--accent); font-weight:bold;">${esc(table)}</span>...</div>
            </div>`;
    }

    try {
        const fStr = JSON.stringify(this.S.appliedFilters || []);
        const sStr = JSON.stringify(this.S.appliedSorts || []);

        const perPageParam = parseInt(this.S.perPage, 10) || 25;
        const url = `${this.apiUrl}?action=data` +
            `&db=${encodeURIComponent(db)}` +
            `&table=${encodeURIComponent(table)}` +
            `&page=${this.S.page || 1}` +
            `&per_page=${perPageParam}` +
            `&filters=${encodeURIComponent(fStr)}` +
            `&sorts=${encodeURIComponent(sStr)}` +
            `&match=${this.S.appliedMatch === 'any' ? 'any' : 'all'}`;

        const res = await fetch(url);
        if (res.status === 401) {
            this.handleSessionExpired();
            return;
        }
        const data = await res.json();

        if (!res.ok || data.success === false) throw new Error(data.error || 'Failed to fetch table data');

        this.S.totalRows = data.totalRows || 0;

        // Applying a filter can shrink the result below the current page, which
        // would leave the UI showing an empty "Page 5 / 1". Clamp and refetch.
        const totalPages = Math.max(1, Math.ceil(this.S.totalRows / perPageParam));
        if ((this.S.page || 1) > totalPages) {
            this.S.page = totalPages;
            return this.loadTableDataFromServer(db, table, opts);
        }

        // Map column schema
        this.APP.schemas[table] = (data.schema || []).map(col => ({
            n: col.Field,
            t: col.Type,
            x: col.Key === 'PRI' ? 'PK' : col.Key === 'MUL' ? 'IDX' : col.Key === 'UNI' ? 'UNI' : '',
            null: col.Null === 'YES',
            def: col.Default,
            extra: col.Extra || '',
            collate: col.Collation || '',
            comment: col.Comment || ''
        }));

        this.APP.colHeaders[table] = (data.schema || []).map(col => col.Field);
        // The Structure tab overview / foreign keys may have changed too; reload them lazily.
        if (this.APP.structInfo) delete this.APP.structInfo[`${db}\u0000${table}`];
        this.APP.tableData[table] = (data.data || []).map(row =>
            this.APP.colHeaders[table].map(key => row[key])
        );

        // Relationship columns: where each points, and names for this page's values.
        if (!this.APP.fkMeta) this.APP.fkMeta = {};
        if (!this.APP.fkLabels) this.APP.fkLabels = {};
        this.APP.fkMeta[table] = data.fk_meta || {};
        this.APP.fkLabels[table] = data.fk_labels || {};

        this.renderSidebar();
        this.renderPanel();
        this.updateStatus();

    } catch (error) {
        console.error("loadTableDataFromServer error:", error);
        if (this.S.tab === 'browse' || this.S.tab === 'structure') {
            this.renderLoadError(db, table, error.message);
        }
        // Keep the app navigable even though this table couldn't be opened.
        this.renderSidebar();
        this.updateStatus();
        this.showMsg(error.message, "error");
    }
}

export async function saveCell(rowIndex, colIndex, el) {
    const table = this.S.table;
    const schema = this.APP.schemas[table] || [];
    const headers = this.APP.colHeaders[table] || [];
    const colDef = schema[colIndex] || {};

    let newValue;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
        newValue = el.value;
        if (newValue === '') newValue = colDef.null ? null : '';
    } else {
        newValue = el.innerText.trim();
        if (newValue === '') newValue = colDef.null ? null : '';
    }

    const row = this.APP.tableData[table]?.[rowIndex];
    if (!row) return;

    const oldValue = row[colIndex];

    // Close input if unchanged
    if (String(newValue) === String(oldValue) || (newValue === null && oldValue === null)) {
        if (el.tagName === 'INPUT') {
            this.renderPanel();
        } else if (el.tagName !== 'SELECT' && el.dataset.null === '1') {
            // beginCellEdit() emptied the NULL placeholder; put it back.
            el.innerHTML = '<span class="null-val">NULL</span>';
        }
        return;
    }

    const pkColIndex = schema.findIndex(c => c.x === 'PK');
    if (pkColIndex === -1) {
        this.showMsg("Cannot edit: Table has no Primary Key", "error");
        if (el.tagName === 'SELECT' || el.tagName === 'INPUT') el.value = oldValue !== null ? oldValue : '';
        else el.innerText = oldValue !== null ? oldValue : '';
        return;
    }

    const pkColName = headers[pkColIndex];
    const pkValue = row[pkColIndex];
    const colName = headers[colIndex];

    try {
        if (el.tagName !== 'SELECT') el.style.backgroundColor = 'rgba(245, 166, 35, 0.2)';

        const res = await fetch(`${this.apiUrl}?action=update_cell`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: this.S.db, table, column: colName, value: newValue, pk_col: pkColName, pk_val: pkValue })
        });

        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || 'Failed to update cell');

        this.APP.tableData[table][rowIndex][colIndex] = newValue;

        if (el.tagName !== 'SELECT') {
            el.style.backgroundColor = 'rgba(62, 207, 142, 0.2)';
            setTimeout(() => el.style.backgroundColor = '', 1000);
        }
        this.renderPanel();
        this.showMsg(`Updated ${colName} successfully`);
    } catch (err) {
        if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
            el.value = oldValue !== null ? oldValue : '';
            if (el.tagName === 'INPUT') {
                el.style.backgroundColor = 'rgba(240, 82, 82, 0.2)';
                setTimeout(() => this.renderPanel(), 1000);
            }
        } else {
            el.innerText = oldValue !== null ? oldValue : '';
            el.style.backgroundColor = 'rgba(240, 82, 82, 0.2)';
            setTimeout(() => el.style.backgroundColor = '', 1000);
        }
        this.showMsg(err.message, 'error');
    }
}

export async function fetchTablesStatus(db) {
    const res = await fetch(`${this.apiUrl}?action=get_tables_status&db=${encodeURIComponent(db)}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
        if (data.session_expired) {
            this.handleSessionExpired();
            return [];
        }
        throw new Error(data.error || 'Failed to fetch table details');
    }
    return data.tables || [];
}

export async function requestExport(params) {
    const res = await fetch(`${this.apiUrl}?action=export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        if (data.session_expired) {
            this.handleSessionExpired();
            return null;
        }
        throw new Error(data.error || 'Export failed');
    }
    return data;
}

export async function previewImportApi(formData) {
    const res = await fetch(`${this.apiUrl}?action=import_preview`, {
        method: 'POST',
        body: formData
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        if (data.session_expired) {
            this.handleSessionExpired();
            return null;
        }
        throw new Error(data.error || 'Preview failed');
    }
    return data;
}

export async function runImportApi(formData) {
    const res = await fetch(`${this.apiUrl}?action=import`, {
        method: 'POST',
        body: formData
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        if (data.session_expired) {
            this.handleSessionExpired();
            return null;
        }
        throw new Error(data.error || 'Import failed');
    }
    return data;
}
