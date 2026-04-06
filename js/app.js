import * as api from './api.js';
import * as actions from './actions.js';
import * as render from './render.js';

class DBManager {
  constructor(containerId, apiUrl = 'api.php') {
    this.container = document.getElementById(containerId);
    this.apiUrl = apiUrl;

    // Application State
    this.S = {
      db: '', table: '', tab: 'browse', page: 1, perPage: 15,
      queryResult: null, queryHeaders: [], msg: null, msgType: 'success',
      isLoggedIn: false, user: 'root', host: 'localhost:3306',
      expandedDbs: new Set(), selected: new Set(),
      showBuilder: false, filters: [], appliedFilters: [], sorts: [], appliedSorts: []
    };

    this.APP = { databases: {}, schemas: {}, tableData: {}, colHeaders: {} };
    window._dbm = this;

    this.container.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:var(--text2);font-family:var(--font-mono)">Checking session...</div>`;
    this.init();
  }

  async init() {
    try {
      const res = await fetch(`${this.apiUrl}?action=check_session`);
      const data = await res.json();
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

// Initialize the app when the page loads
document.addEventListener("DOMContentLoaded", () => {
  window.DBComponent = new DBManager('db-app', 'api.php');
});