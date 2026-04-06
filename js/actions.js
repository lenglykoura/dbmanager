import { exportData } from './export.js';

export function addFilter() {
    const headers = this.APP.colHeaders[this.S.table] || [];
    this.S.filters.push({ id: Date.now(), active: true, col: headers[0] || '', op: '=', val: '' });
    this.renderPanel();
}

export function removeFilter(id) {
    this.S.filters = this.S.filters.filter(f => f.id !== id);
    this.renderPanel();
}

export function updateFilter(id, field, value) {
    const filter = this.S.filters.find(f => f.id === id);
    if (filter) filter[field] = value;
}

export function addSort() {
    const headers = this.APP.colHeaders[this.S.table] || [];
    this.S.sorts.push({ id: Date.now(), col: headers[0] || '', dir: 'asc' });
    this.renderPanel();
}

export function removeSort(id) {
    this.S.sorts = this.S.sorts.filter(s => s.id !== id);
    this.renderPanel();
}

export function updateSort(id, field, value) {
    const sort = this.S.sorts.find(s => s.id === id);
    if (sort) sort[field] = value;
}

export function applyQueryBuilder() {
    this.S.appliedFilters = JSON.parse(JSON.stringify(this.S.filters));
    this.S.appliedSorts = JSON.parse(JSON.stringify(this.S.sorts));
    this.S.page = 1;
    this.renderPanel();
}

export function toggleRow(idx) {
    if (this.S.selected.has(idx)) this.S.selected.delete(idx);
    else this.S.selected.add(idx);
    this.renderPanel();
}

export function toggleAll(checked, pageRowsIndices) {
    for (let idx of pageRowsIndices) {
        if (checked) this.S.selected.add(idx);
        else this.S.selected.delete(idx);
    }
    this.renderPanel();
}

export async function deleteSelected() {
    if (!this.S.selected.size || !confirm(`Permanently delete ${this.S.selected.size} row(s)?`)) return;

    const table = this.S.table;
    const schema = this.APP.schemas[table];
    const pkIndex = schema.findIndex(c => c.x === 'PK');

    if (pkIndex === -1) return this.showMsg("Table requires a Primary Key to delete rows.", "error");

    let successCount = 0;
    for (const idx of this.S.selected) {
        const pkVal = this.APP.tableData[table][idx][pkIndex];
        try {
            await fetch(`${this.apiUrl}?action=delete_row`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ db: this.S.db, table, pk_col: this.APP.colHeaders[table][pkIndex], pk_val: pkVal })
            });
            successCount++;
        } catch (e) { console.error(e); }
    }

    this.S.selected.clear();
    this.showMsg(`Deleted ${successCount} row(s).`);
    await this.loadTableDataFromServer(this.S.db, table);
}

export async function copySelected() {
    if (!this.S.selected.size) return;

    const table = this.S.table;
    const schema = this.APP.schemas[table];
    const pkIndex = schema.findIndex(c => c.x === 'PK');

    let successCount = 0;
    for (const idx of this.S.selected) {
        const rowData = this.APP.tableData[table][idx];
        let insertData = {};

        this.APP.colHeaders[table].forEach((h, i) => {
            if (i !== pkIndex) insertData[h] = rowData[i];
        });

        try {
            await fetch(`${this.apiUrl}?action=insert_row`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ db: this.S.db, table, data: insertData })
            });
            successCount++;
        } catch (e) { console.error(e); }
    }

    this.S.selected.clear();
    this.showMsg(`Duplicated ${successCount} row(s).`);
    await this.loadTableDataFromServer(this.S.db, table);
}

export function exportSelected(format) {
    const table = this.S.table;
    const headers = this.APP.colHeaders[table];
    let rowsToExport = this.APP.tableData[table] || [];

    if (this.S.selected.size > 0) {
        const indices = Array.from(this.S.selected).sort((a, b) => a - b);
        rowsToExport = indices.map(i => this.APP.tableData[table][i]);
    }

    exportData(format, table, headers, rowsToExport);
}

export function changePage(delta) {
    this.S.page += delta;
    this.renderPanel();
}

export function setPerPage(val) {
    this.S.perPage = parseInt(val);
    this.S.page = 1;
    this.renderPanel();
}

export function selectDb(db) {
    this.S.db = db;
    this.S.table = this.APP.databases[db].tables[0] || '';
    this.S.page = 1; this.S.selected.clear();
    this.S.filters = []; this.S.appliedFilters = [];
    this.S.sorts = []; this.S.appliedSorts = [];

    if (this.S.table) this.loadTableDataFromServer(this.S.db, this.S.table);
    else { this.renderSidebar(); this.renderPanel(); this.updateStatus(); }
}

export function selectTable(db, t) {
    this.S.db = db; this.S.table = t; this.S.page = 1;
    this.S.selected.clear();
    this.S.filters = []; this.S.appliedFilters = [];
    this.S.sorts = []; this.S.appliedSorts = [];
    this.S.expandedDbs.add(db);
    this.loadTableDataFromServer(this.S.db, this.S.table);
}

export function toggleDb(db) {
    if (this.S.expandedDbs.has(db)) this.S.expandedDbs.delete(db);
    else this.S.expandedDbs.add(db);
    this.renderSidebar();
}

export function showTab(tab) {
    this.S.tab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + tab)?.classList.add('active');
    this.renderPanel();
}

// ─── STRUCTURE CONTROL LOGIC ───────────────────────────────

export function openAddColumnModal() {
    // Create a dynamic modal
    const modalHtml = `
        <div id="col-modal-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.65); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter:blur(2px);">
            <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); padding:24px; width:400px; box-shadow:0 24px 64px rgba(0,0,0,0.5);">
                <div style="font-family:var(--font-display); font-size:15px; font-weight:700; margin-bottom:18px;">＋ Add Column to ${this.S.table}</div>
                
                <div style="display:flex; flex-direction:column; gap:12px;">
                    <div>
                        <label style="font-size:10px; text-transform:uppercase; color:var(--text2);">Column Name</label>
                        <input id="new-col-name" class="search-input" style="width:100%; margin-top:4px;" placeholder="e.g. phone_number" />
                    </div>
                    <div>
                        <label style="font-size:10px; text-transform:uppercase; color:var(--text2);">Data Type</label>
                        <select id="new-col-type" class="search-input" style="width:100%; margin-top:4px;">
                            <option value="VARCHAR(255)">VARCHAR(255)</option>
                            <option value="INT">INT</option>
                            <option value="TEXT">TEXT</option>
                            <option value="DATETIME">DATETIME</option>
                            <option value="TINYINT(1)">BOOLEAN / TINYINT(1)</option>
                            <option value="DECIMAL(10,2)">DECIMAL(10,2)</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size:10px; text-transform:uppercase; color:var(--text2);">Allow NULL?</label>
                        <select id="new-col-null" class="search-input" style="width:100%; margin-top:4px;">
                            <option value="1">Yes (NULL)</option>
                            <option value="0">No (NOT NULL)</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size:10px; text-transform:uppercase; color:var(--text2);">Default Value (Optional)</label>
                        <input id="new-col-default" class="search-input" style="width:100%; margin-top:4px;" placeholder="Leave blank for none" />
                    </div>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                    <button class="btn" onclick="document.getElementById('col-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitAddColumn()">Add Column</button>
                </div>
            </div>
        </div>
    `;

    // Append to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export async function submitAddColumn() {
    const colName = document.getElementById('new-col-name').value.trim();
    const colType = document.getElementById('new-col-type').value;
    const isNull = document.getElementById('new-col-null').value === '1';
    const defaultVal = document.getElementById('new-col-default').value.trim();

    if (!colName) return this.showMsg("Column name is required", "error");

    try {
        const res = await fetch(`${this.apiUrl}?action=add_column`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                db: this.S.db, table: this.S.table,
                col_name: colName, col_type: colType,
                is_null: isNull, default_val: defaultVal
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        document.getElementById('col-modal-overlay').remove();
        this.showMsg(`Column '${colName}' added successfully.`);

        // Reload data to reflect new structure
        await this.loadTableDataFromServer(this.S.db, this.S.table);
    } catch (err) {
        this.showMsg(err.message, "error");
    }
}

// export async function dropColumn(colName) {
//     if (!confirm(`Are you sure you want to DROP the column '${colName}'? All data in this column will be lost forever.`)) return;

//     try {
//         const res = await fetch(`${this.apiUrl}?action=drop_column`, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ db: this.S.db, table: this.S.table, col_name: colName })
//         });

//         const data = await res.json();
//         if (!res.ok) throw new Error(data.error);

//         this.showMsg(`Column '${colName}' dropped successfully.`);
//         await this.loadTableDataFromServer(this.S.db, this.S.table);
//     } catch (err) {
//         this.showMsg(err.message, "error");
//     }
// }

// ─── ADVANCED STRUCTURE CONTROL LOGIC ───────────────────────────────

export function openColumnEditor(colName = null) {
    const isEdit = !!colName;
    const headers = this.APP.colHeaders[this.S.table] || [];
    const schema = this.APP.schemas[this.S.table] || [];

    // Default empty state
    let c = { n: '', t: 'VARCHAR', len: '255', defType: 'NONE', defVal: '', collate: '', attr: '', null: false, ai: false, comment: '' };

    if (isEdit) {
        const existing = schema.find(s => s.n === colName);
        if (existing) {
            // Parse TYPE and LENGTH (e.g., "varchar(255)" or "enum('a','b')")
            const typeMatch = existing.t.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?/);
            c.n = existing.n;
            c.t = typeMatch ? typeMatch[1].toUpperCase() : 'VARCHAR';
            c.len = typeMatch && typeMatch[2] ? typeMatch[2] : '';

            c.null = existing.null;
            c.ai = existing.extra.includes('auto_increment');
            c.comment = existing.comment || '';
            c.collate = existing.collate || '';
            c.attr = existing.t.includes('unsigned') ? 'UNSIGNED' : (existing.extra.includes('on update') ? 'ON UPDATE CURRENT_TIMESTAMP' : '');

            if (existing.def === null && existing.null) c.defType = 'NULL';
            else if (existing.def === 'CURRENT_TIMESTAMP') c.defType = 'CURRENT_TIMESTAMP';
            else if (existing.def !== null) { c.defType = 'USER_DEFINED'; c.defVal = existing.def; }
        }
    }
    const datatypes = {
        "Frequently Used": ["INT", "VARCHAR", "TEXT", "DATE"],
        "Numeric": ["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "DECIMAL", "FLOAT", "DOUBLE", "REAL", "BIT", "BOOLEAN", "SERIAL"],
        "Date and time": ["DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR"],
        "String": ["CHAR", "VARCHAR", "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "BINARY", "VARBINARY", "TINYBLOB", "MEDIUMBLOB", "BLOB", "LONGBLOB", "ENUM", "SET"],
        "Spatial": ["GEOMETRY", "POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON", "GEOMETRYCOLLECTION"],
        "JSON": ["JSON"]
    };

    // Helper to generate the options HTML
    const typeOptionsHtml = Object.entries(datatypes).map(([group, types]) => `
        <optgroup label="${group}">
            ${types.map(t => `<option value="${t}" ${c.t === t ? 'selected' : ''}>${t}</option>`).join('')}
        </optgroup>
    `).join('');

    const modalHtml = `
        <div id="col-modal-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter:blur(3px);">
            <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); padding:24px; width:700px; box-shadow:0 24px 64px rgba(0,0,0,0.6);">
                <div style="font-family:var(--font-display); font-size:16px; font-weight:700; margin-bottom:20px;">
                    ${isEdit ? `Edit Column: <span style="color:var(--accent)">${colName}</span>` : `＋ Add Column to ${this.S.table}`}
                </div>
                
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px;">
                    <div><label style="font-size:10px; color:var(--text2);">Name</label><input id="ce-name" class="search-input" style="width:100%" value="${c.n}" /></div>
                    
                    <div><label style="font-size:10px; color:var(--text2);">Type</label>
                     <select id="ce-type" class="search-input" style="width:100%" onchange="window._dbm.handleTypeChange(this.value)">
                        ${typeOptionsHtml}
                    </select>
                    </div>
                    
                    <div><label style="font-size:10px; color:var(--text2);">Length/Values</label>
                        <input id="ce-len" class="search-input" style="width:100%" value="${c.len}" placeholder="${c.t === 'ENUM' ? `e.g. \\'a\\',\\'b\\'` : 'e.g. 255 or 10,2'
        } " />
                    </div >
                    
                    <div><label style="font-size:10px; color:var(--text2);">Default</label>
                        <select id="ce-def-type" class="search-input" style="width:100%" onchange="document.getElementById('ce-def-val').style.display = this.value === 'USER_DEFINED' ? 'block' : 'none'">
                            <option value="NONE" ${c.defType === 'NONE' ? 'selected' : ''}>None</option>
                            <option value="USER_DEFINED" ${c.defType === 'USER_DEFINED' ? 'selected' : ''}>As defined:</option>
                            <option value="NULL" ${c.defType === 'NULL' ? 'selected' : ''}>NULL</option>
                            <option value="CURRENT_TIMESTAMP" ${c.defType === 'CURRENT_TIMESTAMP' ? 'selected' : ''}>CURRENT_TIMESTAMP</option>
                        </select>
                        <input id="ce-def-val" class="search-input" style="width:100%; margin-top:6px; display:${c.defType === 'USER_DEFINED' ? 'block' : 'none'}" value="${c.defVal}" placeholder="Default value" />
                    </div>

                    <div><label style="font-size:10px; color:var(--text2);">Collation</label>
                        <select id="ce-collate" class="search-input" style="width:100%">
                            <option value="">(Default)</option>
                            <option value="utf8mb4_general_ci" ${c.collate === 'utf8mb4_general_ci' ? 'selected' : ''}>utf8mb4_general_ci</option>
                            <option value="utf8mb4_unicode_ci" ${c.collate === 'utf8mb4_unicode_ci' ? 'selected' : ''}>utf8mb4_unicode_ci</option>
                        </select>
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

                    <div style="grid-column: span 2;"><label style="font-size:10px; color:var(--text2);">Comments</label><input id="ce-comment" class="search-input" style="width:100%" value="${c.comment}" placeholder="Internal comment" /></div>
                </div >

                <div style="margin-top:16px;">
                    <label style="font-size:10px; color:var(--text2);">Move Column To:</label>
                    <select id="ce-position" class="search-input" style="width:100%; max-width:220px; display:block; margin-top:4px;">
                        <option value="">Do not move</option>
                        <option value="FIRST">At Beginning (FIRST)</option>
                        ${headers.map(h => `<option value="AFTER \`${h}\`">After ${h}</option>`).join('')}
                    </select>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:24px; border-top:1px solid var(--line); padding-top:16px;">
                    <button class="btn" onclick="document.getElementById('col-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitColumnEditor(${isEdit}, '${colName}')">Save Changes</button>
                </div>
            </div >
        </div >
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
    const payload = {
        db: this.S.db, table: this.S.table,
        is_edit: isEdit, old_name: oldName,
        col_name: document.getElementById('ce-name').value.trim(),
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

    if (!payload.col_name) return this.showMsg("Column name is required", "error");

    try {
        const res = await fetch(`${this.apiUrl}?action=save_column`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        document.getElementById('col-modal-overlay').remove();
        this.showMsg(`Column successfully ${isEdit ? 'updated' : 'added'}.`);
        await this.loadTableDataFromServer(this.S.db, this.S.table);
    } catch (err) {
        this.showMsg(err.message, "error");
    }
}

export async function dropColumn(colName) {
    if (!confirm(`DROP column '${colName}' ? All data will be lost!`)) return;
    try {
        await fetch(`${this.apiUrl}?action = drop_column`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: this.S.db, table: this.S.table, col_name: colName })
        });
        this.showMsg(`Column dropped.`);
        await this.loadTableDataFromServer(this.S.db, this.S.table);
    } catch (err) { this.showMsg(err.message, "error"); }
}

export async function addIndex(colName, type) {
    try {
        await fetch(`${this.apiUrl}?action = add_index`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: this.S.db, table: this.S.table, col_name: colName, index_type: type })
        });
        this.showMsg(`Added ${type} index to ${colName}.`);
        await this.loadTableDataFromServer(this.S.db, this.S.table);
    } catch (err) { this.showMsg(err.message, "error"); }
}

export async function loadIndexes() {
    const res = await fetch(`${this.apiUrl}?action=get_indexes&db=${this.S.db}&table=${this.S.table}`);
    const data = await res.json();
    this.S.currentIndexes = data.indexes;
    this.renderPanel();
}

export async function dropIndex(keyName) {
    if (!confirm(`Are you sure you want to drop index '${keyName}'?`)) return;
    try {
        await fetch(`${this.apiUrl}?action=drop_index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: this.S.db, table: this.S.table, key_name: keyName })
        });
        this.showMsg(`Index '${keyName}' dropped.`);
        this.loadIndexes(); // Refresh list
    } catch (err) { this.showMsg(err.message, "error"); }
}

export function openAddIndexModal() {
    const headers = this.APP.colHeaders[this.S.table] || [];
    const modalHtml = `
        <div id="index-modal-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter:blur(3px);">
            <div style="background:var(--bg1); border:1px solid var(--line2); border-radius:var(--radius-lg); padding:24px; width:400px; box-shadow:0 24px 64px rgba(0,0,0,0.6);">
                <div style="font-family:var(--font-display); font-size:16px; font-weight:700; margin-bottom:20px;">＋ Add New Index</div>
                <div style="display:flex; flex-direction:column; gap:12px;">
                    <div>
                        <label style="font-size:10px; color:var(--text2);">Index Name (Optional)</label>
                        <input id="idx-name" class="search-input" style="width:100%" placeholder="e.g. idx_user_email" />
                    </div>
                    <div>
                        <label style="font-size:10px; color:var(--text2);">Column</label>
                        <select id="idx-col" class="search-input" style="width:100%">
                            ${headers.map(h => `<option value="${h}">${h}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label style="font-size:10px; color:var(--text2);">Index Type</label>
                        <select id="idx-type" class="search-input" style="width:100%">
                            <option value="INDEX">INDEX (Standard)</option>
                            <option value="UNIQUE">UNIQUE</option>
                            <option value="PRIMARY">PRIMARY KEY</option>
                        </select>
                    </div>
                </div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:24px;">
                    <button class="btn" onclick="document.getElementById('index-modal-overlay').remove()">Cancel</button>
                    <button class="btn primary" onclick="window._dbm.submitIndex()">Create Index</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export async function submitIndex() {
    const col = document.getElementById('idx-col').value;
    const type = document.getElementById('idx-type').value;

    try {
        // 1. Send the command to the API
        const res = await fetch(`${this.apiUrl}?action=add_index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                db: this.S.db,
                table: this.S.table,
                col_name: col,
                index_type: type
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add index');

        // 2. Remove the modal
        const modal = document.getElementById('index-modal-overlay');
        if (modal) modal.remove();

        // 3. Show success message
        this.showMsg(`Index (${type}) added to ${col} successfully.`);

        // 4. CRITICAL: Re-fetch the indexes from the database to show the new row
        await this.loadIndexes();

    } catch (err) {
        this.showMsg(err.message, "error");
    }
}