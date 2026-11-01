# DBManager: a free, open-source phpMyAdmin alternative for MySQL & MariaDB

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![PHP 8+](https://img.shields.io/badge/PHP-8.0%2B-777bb4?logo=php&logoColor=white)
![MySQL & MariaDB](https://img.shields.io/badge/MySQL%20%7C%20MariaDB-supported-4479a1?logo=mysql&logoColor=white)
![No build step](https://img.shields.io/badge/build-none%20needed-success)

**DBManager** is a fast, lightweight **web-based MySQL and MariaDB database manager**: a modern alternative to phpMyAdmin with a Navicat-style layout. Browse and edit data, design tables, run SQL, and import or export (with gzip) huge databases from your browser. Plain PHP 8 on the server and vanilla JavaScript in the browser: no framework, no build step, no Composer. Copy it to any PHP server (Laragon, XAMPP, Herd, Apache, Nginx) and open it.

**Website:** <https://lenglykoura.github.io/dbmanager/>   ·   **Download:** [latest ZIP](https://github.com/lenglykoura/dbmanager/archive/refs/heads/main.zip)

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Usage guide](#usage-guide)
- [Project structure](#project-structure)
- [Security](#security)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Sidebar: every database object in one tree
- Databases expand into **Tables, Views, Functions, Triggers, Events, saved Queries and Backups**, with counts.
- Search as you type, expand/collapse all, refresh without reloading the page.
- **Pin** databases and tables you use often; they stay at the top.
- Right-click any item for its actions (open, design, rename, drop, show the `CREATE` statement…).
- Resizable, slides open and closed; on phones it starts hidden and opens as a drawer.

### Objects tab: manage tables like Navicat
- A grid of every table and view with rows, auto-increment, data size, index size, engine, collation, last change and comment.
- Toolbar and right-click menu: **Open, Design, New Table, Rename, Duplicate, Empty (truncate), Drop, Import, Export**.
- Select several tables with the tick boxes; double-click to open, <kbd>F2</kbd> to rename, <kbd>Del</kbd> to drop.
- Broken views (e.g. MySQL error 1449, *"the user specified as a definer does not exist"*) are flagged and can be fixed in one click.

### Browse tab: view and edit data
- Paginated grid (25 to 1,000 rows per page) with Excel-style cell borders and resizable columns.
- **Double-click a cell to edit it**, with an editor that fits the column type:
  - date / datetime / time → the browser's date-time picker;
  - integers and decimals → checked against the column's range and number of decimals as you type;
  - `ENUM` → a dropdown; nullable columns get a **NULL** button.
- **Foreign keys show names, not just IDs** (e.g. `7 MOM VANNA`), with a searchable picker to change them and a link to jump to the referenced row.
- **Filter & Sort** bar: conditions such as `=`, `≠`, contains, starts/ends with, `>`, `<`, between, is empty, is NULL; match all or any; multi-column sorting. A quick **Filter Row** sits under the headers.
- Insert, duplicate and delete rows; export the grid to CSV or JSON.

### Structure tab: design a table
- A compact overview (columns, rows, data and index size, next ID, engine, collation, last update).
- Columns with type, NULL, default, keys and comments; add, edit, drop, insert after, move up/down.
- **Indexes** (primary, unique, normal, composite) and **foreign keys** (with ON DELETE / ON UPDATE rules): add, edit, drop.
- **Referenced by**: which other tables point to this one.
- Copy the full `CREATE TABLE` statement.

### SQL tab: a phpMyAdmin-style query editor
- CodeMirror editor with syntax colours and autocomplete for every table and column in the database (<kbd>Ctrl</kbd>+<kbd>Space</kbd>).
- <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs the selection or the statement under the cursor; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> runs everything; one result tab per statement.
- Column list beside the editor (click to insert) and templates: **SELECT \*, SELECT, INSERT, UPDATE, DELETE**, plus **Format** (tidies the SQL) and **Clear**.
- After a run the editor folds into a short summary, e.g. *"Showing rows 1 – 25 (27,573 total, query took 4 ms)"*, with **Edit, Explain, Refresh, Copy, Save query**.
- **Edit results in place**: when the query is a plain `SELECT` from one table that includes its primary key, double-click a cell to change it. Other results stay read-only and say why.
- Asks before running `DROP`, `TRUNCATE`, or `UPDATE` / `DELETE` without a real `WHERE`.
- Query history, saved queries (in the sidebar) and export of the whole result to CSV / JSON.

### Export
- Whole database (pick tables and views) or a single table, as **SQL, CSV or JSON**.
- SQL options: structure and/or data, `DROP TABLE IF EXISTS`, `CREATE DATABASE`, foreign key checks off, triggers / routines / events / views (views ordered by dependency), with or without `DEFINER`.
- **Any size**: the file is streamed while it is built, so a 1 GB database exports with little server memory and no time limit.
- **Compress (gzip)**: downloads `.sql.gz`, usually 5–10× smaller.
- Shows the database size, the size of what you selected and an estimated row count before you start.

### Import
- Drag and drop `.sql`, `.csv` or `.json` (also compressed as `.gz`), or paste SQL.
- SQL scripts are split correctly (strings, comments and `DELIMITER` blocks are respected); option to keep going after an error.
- CSV / JSON into a table: delimiter detection, header row, and **Insert, Replace** or **Truncate & Insert** mode.
- Preview before importing, then a report of statements run, rows affected, time taken and any errors.

### Backups
- One-click backup of a database to the server, listed in the sidebar; **download, restore or delete** any backup.
- Stored outside the web folder (see [Backups folder](#backups-folder)).

### Everywhere
- Dark and light themes; works on phones (drawer sidebar, scrolling grids).
- **The address bar follows you** (`#db=…&table=…&tab=…`): tabs are links, so you can open any tab or table in a new browser tab, bookmark it, or reload in place.
- Console bar at the bottom with the latest message; expand it for the full log.

---

## Requirements

| | |
|---|---|
| **PHP** | 8.0 or newer, with `pdo_mysql`. `zlib` is needed for gzip export and `.gz` import (it is on by default in most PHP builds). |
| **Database** | MySQL 5.7 / 8.x or MariaDB 10.3+ |
| **Browser** | A current Chrome, Edge, Firefox or Safari |

No Composer, Node or build step. The browser loads CodeMirror and the Tabler icon font from public CDNs, so it needs internet access.

---

## Getting started

### PHP's built-in server (quickest)

```bash
git clone https://github.com/lenglykoura/dbmanager.git
cd dbmanager
php -S localhost:8000
```

Open <http://localhost:8000> and log in with your MySQL host, user and password.

### Laragon, Herd, XAMPP, Apache or Nginx

Put the `dbmanager` folder in your web root (e.g. `C:\laragon\www\dbmanager` → `http://dbmanager.test`, or XAMPP's `htdocs` → `http://localhost/dbmanager`). Nothing else to configure: `index.html` is the page and `php/api.php` is the API.

On **Nginx**, PHP-FPM must handle `php/api.php`. For large exports, add `fastcgi_buffering off;` (DBManager also sends `X-Accel-Buffering: no`) so the download starts right away.

### Backups folder

Backups are saved **outside** the web folder, in `dbmanager-backups/` next to the project's parent folder (for example `C:\laragon\dbmanager-backups` when the app is in `C:\laragon\www\dbmanager`), so they can't be downloaded by URL. The web server's user needs write access there. To use another place, change `BACKUP_DIR` near the top of the backup section in `php/api.php`.

---

## Usage guide

### Connect
On the login screen enter **host:port** (default `localhost:3306`), **user** and **password**. Optionally pick a database to open, and tick **Remember** to keep host, user and database (never the password) for next time.

### Export a database
1. Choose a database in the sidebar and open **Export**.
2. Pick **Database** or **Table** at the top right, then the format.
3. Set the options. Keep **Compress (gzip)** on for a small download.
4. Untick any tables or views you don't need. The size of your selection is shown.
5. Click **Download Export File**. Your browser saves it with its normal download progress.

**Preview / Copy** shows the export on the page instead; it is limited to 20 MB.

> The size shown is MySQL's size on disk, which includes indexes and free space. The exported SQL is usually smaller (often about half), and smaller again when compressed.

### Import
1. Open **Import** and drop a file (`.sql`, `.csv`, `.json`, or any of them as `.gz`), or paste SQL.
2. For CSV / JSON choose the target table, delimiter, header row and mode.
3. Check the preview, then click **Start Import**.

### Edit query results
In **SQL**, run for example ``SELECT * FROM `loans` WHERE status = 1;``. The bar above the grid says *"Double-click a cell to edit loans"*; changes are saved with `UPDATE … WHERE <primary key> LIMIT 1`. If the result can't be edited (joins, `GROUP BY`, calculated columns, no primary key), the bar says why.

---

## Project structure

```
dbmanager/
├── index.html          # The page: loads CodeMirror, icons and the JS modules (with ?v= cache-busting)
├── css/
│   └── style.css       # All styles: themes, layout, shared data grid, phone layout
├── php/
│   └── api.php         # JSON API: login, queries, schema changes, export/import, backups
├── image/
│   └── icon.ico
└── js/
    ├── app.js          # App state and start-up; attaches the CSRF token to requests
    ├── api.js          # Loading data from the API
    ├── actions.js      # User actions: browse, edit, export/import workflows
    ├── render.js       # Page shell, Browse grid, Export and Import panels
    ├── objects.js      # Objects tab, table operations, context menus
    ├── dbtree.js       # Sidebar tree, pins, saved queries, backups
    ├── structure.js    # Structure tab: columns, indexes, foreign keys
    ├── sqleditor.js    # SQL tab: editor, templates, formatter, results, in-place editing
    ├── filters.js      # Filter & Sort bar
    ├── relations.js    # Foreign key labels and picker
    ├── cellinput.js    # Type-aware cell editors (dates, numbers, decimals)
    ├── dialog.js       # Confirm / alert / prompt / form dialogs
    ├── router.js       # Keeps the address bar in sync; open in new tab
    ├── export.js       # Client-side CSV/JSON export and file download helpers
    └── util.js         # Escaping helpers
```

After changing a JS or CSS file, bump the `?v=` number in `index.html` so browsers load the new version.

---

## Security

- **Your MySQL login stays on the server** in the PHP session. The password is never sent back to the browser or stored in it.
- **CSRF protection**: every request that changes something must carry the session's token.
- **Login throttling**: after 5 failed attempts, logins are locked for a growing delay (up to 5 minutes). The session ID changes on login.
- **Cookies**: `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS.
- **SQL injection**: values go through PDO prepared statements; database, table and column names are escaped with backticks.
- **Errors** are logged on the server instead of being shown in responses.

DBManager gives full control over every database the MySQL user can reach. **Don't expose it to the internet as is**: run it locally, or put it behind HTTPS plus HTTP authentication or an IP allow-list, and log in with a MySQL user that only has the rights it needs.

---

## FAQ

**Do I need Composer or npm?**
No. Copy the folder to a PHP server and open it.

**Can it manage a remote MySQL server?**
Yes. Enter the remote `host:port` at login. The server must accept remote connections for that user.

**How big can an export be?**
There is no fixed limit: exports are streamed to your browser, and you can gzip them on the fly. Imports, however, are read into memory in one go, so very large files are limited by PHP's `memory_limit` and `upload_max_filesize` / `post_max_size`. For multi-GB restores use the `mysql` command-line client.

**Why is my export smaller than the size shown?**
The shown size is what MySQL uses on disk, including indexes and free space. A dump only contains the data and the `CREATE` statements; MySQL rebuilds the indexes when you import it.

**The page looks old after an update.**
Hard-refresh (<kbd>Ctrl</kbd>+<kbd>F5</kbd>), and make sure the `?v=` numbers in `index.html` were bumped.

---

## Contributing

1. Fork the repository and create a branch: `git checkout -b feature/my-change`.
2. Make your change in the existing style: ES modules, small functions, plain PHP with PDO.
3. Bump `?v=` in `index.html` if you changed JS or CSS, and try the change in both themes and at phone width.
4. Commit, push and open a pull request against `main`.

---

## License

[MIT](LICENSE). Free to use, change and share for personal and commercial projects.
