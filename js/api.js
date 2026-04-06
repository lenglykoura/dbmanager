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
    try {
        const res = await fetch(`${this.apiUrl}?action=data&db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`);
        const data = await res.json();

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
        this.APP.colHeaders[table] = data.schema.map(col => col.Field);
        this.APP.tableData[table] = data.data.map(row => this.APP.colHeaders[table].map(key => row[key]));

        this.renderSidebar();
        this.renderPanel();
        this.updateStatus();
    } catch (error) { console.error(error); }
}

export async function runQuery() {
    const q = (document.getElementById('sql-input')?.value || '').trim();
    if (!q) return;

    try {
        const res = await fetch(`${this.apiUrl}?action=query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: q, db: this.S.db })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Query failed');

        this.S.queryResult = data.results && data.results.length > 0 ? data.results : null;
        if (this.S.queryResult) {
            this.S.queryHeaders = Object.keys(this.S.queryResult[0]);
            this.S.queryResult = this.S.queryResult.map(row => Object.values(row));
            this.showMsg(`Query OK — ${this.S.queryResult.length} rows returned`);
        } else {
            this.S.queryHeaders = [];
            this.showMsg(`Query OK — ${data.rowCount} rows affected`);
        }

        this.renderPanel();
        document.getElementById('sql-input').value = q;
        if (q.toLowerCase().match(/^(create|drop|alter)/)) await this.loadDatabasesFromServer();
    } catch (error) {
        this.S.queryResult = null;
        this.showMsg(error.message, 'error');
        this.renderPanel();
        document.getElementById('sql-input').value = q;
    }
}

export async function saveCell(rowIndex, colIndex, el) {
    const table = this.S.table;
    const schema = this.APP.schemas[table];
    const headers = this.APP.colHeaders[table];

    // Determine how to get the value based on the HTML element type
    let newValue;
    if (el.tagName === 'SELECT') {
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
        if (el.tagName === 'SELECT') {
            el.value = oldValue !== null ? oldValue : '';
        } else {
            el.innerText = oldValue !== null ? oldValue : '';
            el.style.backgroundColor = 'rgba(240, 82, 82, 0.2)';
            setTimeout(() => el.style.backgroundColor = 'transparent', 1000);
        }
        this.showMsg(err.message, 'error');
    }
}