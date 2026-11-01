// Shared escaping helpers.
//
// Every panel in this app is built by string-concatenating HTML and assigning it
// to innerHTML, so any value that comes from the database (row values, column
// names, table names, MySQL error text) has to be escaped on the way in.

/** Table / view icons, shared by the sidebar and the Objects view. */
export const TABLE_ICON = `<i class="ti ti-table tbl-icon" aria-hidden="true"></i>`;
export const VIEW_ICON = `<i class="ti ti-eye-table tbl-icon view-icon" aria-hidden="true"></i>`;

/** A Tabler webfont icon, e.g. ti('download'). Names: https://tabler.io/icons */
export const ti = (name) => `<i class="ti ti-${name}" aria-hidden="true"></i>`;

/** Escape a value for use as HTML text or inside a double-quoted attribute. */
export function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Escape a value for use inside a single-quoted JS string that itself lives in
 * an HTML attribute, e.g. onclick="window._dbm.fn('<here>')".
 * Backslash-escape for the JS parser first, then HTML-escape for the attribute.
 */
export function escJs(v) {
    const s = String(v === null || v === undefined ? '' : v)
        .split('\\').join('\\\\')
        .split("'").join("\\'");
    return esc(s);
}
