// The address bar mirrors where you are: #db=kag_db&table=loans&tab=browse.
// That makes every view a link, so tabs and tables can be opened in a new
// browser tab (middle-click, Ctrl+click, or "Open link in new tab"), and a
// page loaded with such an address opens straight on that view.

const TABS = ['objects', 'browse', 'structure', 'sql', 'export', 'import'];

/** { db?, table?, tab? } from the current address (only what it names). */
export function readUrlState() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const s = {};
  if (p.get('db')) s.db = p.get('db');
  if (s.db) s.table = p.get('table') || '';
  if (TABS.includes(p.get('tab'))) s.tab = p.get('tab');
  return s;
}

export function urlFor(db, table, tab) {
  const p = new URLSearchParams();
  if (db) p.set('db', db);
  if (db && table) p.set('table', table);
  if (tab) p.set('tab', tab);
  return `${location.pathname}${location.search}#${p.toString()}`;
}

/** Keep the address bar and the tab links in step with the current view. */
export function syncUrl() {
  if (!this.S.isLoggedIn) return;
  const url = urlFor(this.S.db, this.S.table, this.S.tab);
  if (location.pathname + location.search + location.hash !== url) {
    try { history.replaceState(history.state, '', url); } catch (e) { /* e.g. sandboxed frame */ }
  }
  document.querySelectorAll('#tabbar a.tab[data-tab]').forEach(a => {
    a.setAttribute('href', urlFor(this.S.db, this.S.table, a.dataset.tab));
  });
}

/** Plain click switches tab in place; Ctrl/Cmd/Shift/middle click is left to the browser (new tab/window). */
export function onTabLinkClick(e, tab) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  this.showTab(tab);
}

export function openInNewTab(db, table, tab = 'browse') {
  window.open(urlFor(db, table, tab), '_blank', 'noopener');
}
