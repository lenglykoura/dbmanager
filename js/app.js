import * as api from './api.js';
import * as actions from './actions.js';
import * as render from './render.js';
import * as objects from './objects.js';
import * as relations from './relations.js';
import * as dbtree from './dbtree.js';
import * as dialog from './dialog.js';
import * as filters from './filters.js';
import * as structure from './structure.js';
import * as sqleditor from './sqleditor.js';
import * as router from './router.js';

// Attach the session CSRF token to every state-changing request to the API.
// Centralising it on fetch covers all call sites at once — JSON POSTs and the
// multipart import uploads alike — so no individual request can forget it.
// GET/HEAD (all read-only here, including the export download) are left alone.
if (!window.__dbmFetchPatched) {
  const _origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      if (typeof input === 'string' && input.includes('api.php')) {
        const method = ((init && init.method) || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          const token = window._dbm && window._dbm.S && window._dbm.S.csrf;
          if (token) {
            init = init || {};
            const headers = new Headers(init.headers || {});
            headers.set('X-CSRF-Token', token);
            init.headers = headers;
          }
        }
      }
    } catch (e) {
      // Never let CSRF wiring break an outgoing request.
    }
    return _origFetch(input, init);
  };
  window.__dbmFetchPatched = true;
}

class DBManager {
  constructor(containerId, apiUrl = 'php/api.php') {
    this.container = document.getElementById(containerId);
    this.apiUrl = apiUrl;

    const savedState = JSON.parse(localStorage.getItem('dbm_state') || '{}');
    const savedExpanded = JSON.parse(localStorage.getItem('dbm_expanded') || '[]');
    const savedConn = JSON.parse(localStorage.getItem('dbm_saved_conn') || 'null');
    // An address like #db=x&table=y&tab=browse (e.g. a tab opened in a new window) wins over the saved state.
    const fromUrl = router.readUrlState();
    // Application State
    this.S = {
      db: fromUrl.db || savedState.db || (savedConn?.database || ''),
      table: fromUrl.db ? fromUrl.table : (savedState.table || ''),
      tab: fromUrl.tab || savedState.tab || 'browse',
      // Phones start with the sidebar closed; computers restore the last choice.
      sidebarDesktopPref: savedState.sidebarOpen !== false,
      sidebarOpen: window.innerWidth > 768 && savedState.sidebarOpen !== false,
      theme: savedState.theme || 'light',
      logs: savedState.logs || [],
      terminalOpen: false, // the console always starts collapsed; its bar shows the newest message
      terminalHeight: parseInt(localStorage.getItem('dbm_term_h'), 10) || 180,
      page: 1, perPage: (savedState.perPage === 'all' || !savedState.perPage) ? 25 : (parseInt(savedState.perPage, 10) || 25),
      queryResult: null, queryHeaders: [], msg: null, msgType: 'success',
      csrf: null,
      isLoggedIn: false,
      user: savedConn?.user || savedState.user || 'root',
      host: savedConn?.host || savedState.host || 'localhost:3306',
      savedDb: savedConn?.database || '',
      rememberConn: !!savedConn,
      expandedDbs: new Set(savedExpanded), selected: new Set(),
      showBuilder: false, filters: [], appliedFilters: [], sorts: [], appliedSorts: [],
      colFilters: savedState.colFilters || {},
      showFilterRow: savedState.showFilterRow !== false,
      // Objects view (database-level table list, like Navicat's Objects tab)
      objDb: '',
      objInfo: [],
      objLoading: false,
      objFilter: '',
      objSort: savedState.objSort || { col: 'name', dir: 'asc' },
      objSelected: new Set(),
      objAnchor: null,
      // SQL tab: the open saved query ({ db, id }) and the editor text
      // Filter bar: "all" = AND, "any" = OR between its conditions
      filterMatch: 'all',
      appliedMatch: 'all',
      // SQL tab: one result per statement run, which one is shown, and whether a run is in progress
      sqlResults: [],
      sqlActive: 0,
      sqlRunning: false,
      openQuery: null,
      sqlDraft: undefined,
      // Export & Import State
      exportScope: savedState.table ? 'table' : 'database',
      exportFormat: 'sql',
      exportType: 'all',
      exportTables: new Set(),
      exportDropTable: true,
      exportCreateDb: false,
      exportDisableFk: true,
      exportRoutines: true,
      exportKeepDefiner: false,
      // Download as .gz (compressed while streaming). On unless turned off last time.
      exportGzip: savedState.exportGzip !== false,
      exportTablesInfo: [],
      exportSearchFilter: '',
      exportLoading: false,
      importFormat: 'auto',
      importTargetTable: savedState.table || '',
      importMode: 'insert',
      importDisableFk: true,
      importContinueOnError: false,
      importCsvHasHeaders: true,
      importCsvDelimiter: ',',
      importFile: null,
      importRawData: '',
      importPreviewData: null,
      importLoading: false,
      importResult: null
    };
    const savedSidebarW = localStorage.getItem('dbm_sidebar_w');
    if (savedSidebarW) {
      document.documentElement.style.setProperty('--sidebar-w', savedSidebarW);
    }
    if (this.S.theme === 'light') document.body.classList.add('light-theme');
    this.APP = { databases: {}, schemas: {}, tableData: {}, colHeaders: {}, fkMeta: {}, fkLabels: {} };
    window._dbm = this;

    this.container.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:var(--text2);font-family:var(--font-mono)">Checking session...</div>`;
    this.init();
  }

  async init() {
    try {
      const res = await fetch(`${this.apiUrl}?action=check_session`);
      const data = await res.json();
      // Capture the CSRF token for this session; the fetch wrapper below
      // attaches it to every state-changing request (including the login POST).
      if (data.csrf) this.S.csrf = data.csrf;
      if (data.logged_in) {
        this.S.isLoggedIn = true;
        this.S.user = data.user;
        this.S.host = data.host;
        this.renderShell();
        await this.loadDatabasesFromServer();
      } else {
        this.renderShell();
      }
    } catch (error) {
      console.error("Session check failed:", error);
      this.renderShell();
    }
  }
}

// Wire up all the imported modules to the DBManager prototype
Object.assign(DBManager.prototype, api);
Object.assign(DBManager.prototype, actions);
Object.assign(DBManager.prototype, render);
Object.assign(DBManager.prototype, objects);
Object.assign(DBManager.prototype, relations);
Object.assign(DBManager.prototype, dbtree);
Object.assign(DBManager.prototype, dialog);
Object.assign(DBManager.prototype, filters);
Object.assign(DBManager.prototype, structure);
Object.assign(DBManager.prototype, sqleditor);
Object.assign(DBManager.prototype, router);

// Initialize the app when the page loads
document.addEventListener("DOMContentLoaded", () => {
  window.DBComponent = new DBManager('db-app', 'php/api.php');
});