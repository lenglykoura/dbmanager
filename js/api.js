export async function doLogin() {
    const host = document.getElementById('inp-host').value || 'localhost:3306';
    const user = document.getElementById('inp-user').value || 'root';
    const password = document.getElementById('inp-pass').value || '';
    const database = document.getElementById('inp-db').value || '';

    try {
        const res = await fetch(`${this.apiUrl}?action=connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, user, password, database })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        this.S.user = user;
        this.S.host = host;
        this.S.isLoggedIn = true;

        this.renderShell();
        await this.loadDatabasesFromServer();
    } catch (error) {
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
    this.renderShell();
}

export async function loadDatabasesFromServer() {
    try {
        const dbRes = await fetch(`${this.apiUrl}?action=databases`);
        const dbData = await dbRes.json();
        this.APP.databases = {};

        for (const dbName of dbData.databases) {
            if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(dbName)) continue;
            const tblRes = await fetch(`${this.apiUrl}?action=tables&db=${encodeURIComponent(dbName)}`);
            const tblData = await tblRes.json();
            this.APP.databases[dbName] = { tables: tblData.tables };
        }

        const dbNames = Object.keys(this.APP.databases);
        const firstDb = dbNames[0];

        // 1. VALIDATE SAVED STATE: Check if saved db and table still exist on the server
        if (this.S.db && !this.APP.databases[this.S.db]) {
            this.S.db = ''; // Reset if DB was deleted
            this.S.table = '';
        } else if (this.S.db && this.S.table && !this.APP.databases[this.S.db].tables.includes(this.S.table)) {
            this.S.table = ''; // Reset if Table was deleted
        }

        // 2. DEFAULT TO FIRST: Only if NO DB is selected from localStorage (or it was reset above)
        if (firstDb && !this.S.db) {
            this.S.db = firstDb;
            this.S.table = this.APP.databases[firstDb].tables[0] || '';
            this.S.expandedDbs.add(firstDb);
        }

        // 3. Always ensure the active DB folder is physically expanded in the sidebar
        if (this.S.db) this.S.expandedDbs.add(this.S.db);

        // 4. Save verified state back to storage
        if (typeof this.saveLocalState === 'function') {
            this.saveLocalState();
        }

        // 5. Finally, load the data or just render the shell
        if (this.S.db && this.S.table) {
            await this.loadTableDataFromServer(this.S.db, this.S.table);
        } else {
            this.renderSidebar();
            this.renderPanel();
        }
    } catch (error) {
        console.error(error);
    }
}

export async function loadTableDataFromServer(db, table) {
    if (!db || !table) return;

    // 1. Show loading screen immediately to the user
    const panel = document.getElementById('panel');
    if (panel) {
        panel.innerHTML = `
            <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:var(--text2); font-family:var(--font-mono);">
                <div class="spinner" style="width:24px; height:24px; border-width:3px; margin-bottom:16px;"></div>
                <div>Fetching data for <span style="color:var(--accent); font-weight:bold;">${table}</span>...</div>
            </div>`;
    }

    try {
        // 2. Prepare Filter and Sort parameters for the URL
        // We stringify these arrays so they can be sent as single URL parameters
        const fStr = JSON.stringify(this.S.appliedFilters || []);
        const sStr = JSON.stringify(this.S.appliedSorts || []);

        // 3. Construct the API URL with all necessary parameters
        const url = `${this.apiUrl}?action=data` +
            `&db=${encodeURIComponent(db)}` +
            `&table=${encodeURIComponent(table)}` +
            `&page=${this.S.page}` +
            `&per_page=${this.S.perPage}` +
            `&filters=${encodeURIComponent(fStr)}` +
            `&sorts=${encodeURIComponent(sStr)}`;

        // 4. Fetch the data from the server
        const res = await fetch(url);
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Failed to fetch table data');

        // 5. Store the actual database count for the pagination UI
        this.S.totalRows = data.totalRows || 0;

        // 6. Map the column definitions (Schema)
        this.APP.schemas[table] = data.schema.map(col => ({
            n: col.Field,
            t: col.Type,
            x: col.Key === 'PRI' ? 'PK' : col.Key === 'MUL' ? 'IDX' : col.Key === 'UNI' ? 'UNI' : '',
            null: col.Null === 'YES',
            def: col.Default,
            extra: col.Extra, // captures auto_increment
            collate: col.Collation,
            comment: col.Comment
        }));

        // 7. Store column headers and the paginated row data
        this.APP.colHeaders[table] = data.schema.map(col => col.Field);
        this.APP.tableData[table] = data.data.map(row =>
            this.APP.colHeaders[table].map(key => row[key])
        );

        // 8. Store Foreign Key options for dropdown menus
        if (!this.APP.fkOptions) this.APP.fkOptions = {};
        this.APP.fkOptions[table] = data.fks || {};

        // 9. Refresh the UI components
        this.renderSidebar();
        this.renderPanel();
        this.updateStatus();

    } catch (error) {
        console.error(error);
        if (panel) {
            panel.innerHTML = `
                <div style="padding:24px; color:var(--red); font-family:var(--font-mono);">
                    <strong>Database Error:</strong><br>
                    ${error.message}
                </div>`;
        }
        this.showMsg(error.message, "error");
    }
}

export async function runQuery() {
    const query = this.editor ? this.editor.getValue().trim() : document.getElementById('sql-input').value.trim();
    if (!query) return this.showMsg("Query cannot be empty", "error");

    const btn = document.getElementById('run-query-btn');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.cursor = 'wait';
        btn.innerHTML = '<span class="spinner"></span> Executing...';
    }

    try {
        const res = await fetch(`${this.apiUrl}?action=run_query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                db: this.S.db,
                query: query,
                page: this.S.page,         // Send current page
                per_page: this.S.perPage    // Send rows per page
            })
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        // Update state with paged data and total count
        this.S.queryResult = data.data || [];
        this.S.queryHeaders = data.headers || [];
        this.S.totalRows = data.totalRows || 0; // Use this for pagination UI

        this.showMsg(`Showing ${this.S.queryResult.length} of ${this.S.totalRows.toLocaleString()} rows`);

        this.renderPanel();

    } catch (err) {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.innerHTML = '▶ Execute';
        }
        this.showMsg(err.message, "error");
    }
}

export async function saveCell(rowIndex, colIndex, el) {
    const table = this.S.table;
    const schema = this.APP.schemas[table];
    const headers = this.APP.colHeaders[table];

    // Determine how to get the value based on the HTML element type
    let newValue;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
        newValue = el.value;
        if (newValue === '') newValue = null;
    } else {
        newValue = el.innerText.trim();
        if (newValue === '') newValue = null;
    }

    const oldValue = this.APP.tableData[table][rowIndex][colIndex];
    if (String(newValue) === String(oldValue) || (newValue === null && oldValue === null)) return;

    const pkColIndex = schema.findIndex(c => c.x === 'PK');
    if (pkColIndex === -1) {
        this.showMsg("Cannot edit: Table has no Primary Key", "error");
        if (el.tagName === 'SELECT') el.value = oldValue !== null ? oldValue : '';
        else el.innerText = oldValue !== null ? oldValue : '';
        return;
    }

    const pkColName = headers[pkColIndex];
    const pkValue = this.APP.tableData[table][rowIndex][pkColIndex];
    const colName = headers[colIndex];

    try {
        if (el.tagName !== 'SELECT') el.style.backgroundColor = 'rgba(245, 166, 35, 0.2)';

        const res = await fetch(`${this.apiUrl}?action=update_cell`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: this.S.db, table, column: colName, value: newValue, pk_col: pkColName, pk_val: pkValue })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        this.APP.tableData[table][rowIndex][colIndex] = newValue;

        if (el.tagName !== 'SELECT') {
            el.style.backgroundColor = 'rgba(62, 207, 142, 0.2)';
            setTimeout(() => el.style.backgroundColor = 'transparent', 1000);
        }
        this.showMsg(`Updated ${colName} successfully`);
    } catch (err) {
        // Revert the value if it fails
        if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
            el.value = oldValue !== null ? oldValue : '';
            if (el.tagName === 'INPUT') {
                el.style.backgroundColor = 'rgba(240, 82, 82, 0.2)';
                setTimeout(() => el.style.backgroundColor = 'transparent', 1000);
            }
        } else {
            el.innerText = oldValue !== null ? oldValue : '';
            el.style.backgroundColor = 'rgba(240, 82, 82, 0.2)';
            setTimeout(() => el.style.backgroundColor = 'transparent', 1000);
        }
        this.showMsg(err.message, 'error');
    }
}