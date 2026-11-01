// One dialog component for the whole app. Confirmations, alerts and text prompts
// share the same markup, styles (.dlg-* in style.css), keyboard handling and
// focus management, and each call returns a Promise:
//
//   if (await this.confirmDialog({ title: 'Drop table?', message, type: 'danger', confirmText: 'Drop' })) { ... }
//   await this.alertDialog({ title: 'Saved', message, type: 'success' });
//   const r = await this.promptDialog({ title: 'Rename', label: 'New name', value: old });  // { value, checked } | null
//
// Types: primary (default), info, success, warning, danger, error. They set the
// icon and accent colour; danger/warning/error start with focus on Cancel so
// Enter can't trigger a destructive action by accident.
//
// The older callback helpers (showConfirmDialog / showAlertDialog /
// showPromptDialog) wrap this, so every existing call site looks the same.

import { esc, ti } from './util.js';

const ICONS = {
  primary: 'help-circle',
  info: 'info-circle',
  success: 'circle-check',
  warning: 'alert-circle',
  danger: 'alert-triangle',
  error: 'alert-triangle'
};
const CAUTIOUS = new Set(['danger', 'warning', 'error']);

let stackDepth = 0;
let idSeq = 0;

/** <option> list from ['a', 'b'] or [{ value, label }], with `selected` chosen. */
function fieldOptions(options, selected) {
  return (options || []).map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? (o.label ?? o.value) : o;
    return `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
  }).join('');
}

/**
 * Opens a dialog and resolves when it closes.
 *
 * opts: {
 *   title, message,                 plain text (newlines kept)
 *   details,                        optional monospace block (lists, SQL, errors)
 *   type, icon,                     see above; icon overrides the type's Tabler icon
 *   confirmText, cancelText,        cancelText: null makes it a one-button alert
 *   input: { label, value, placeholder, maxlength, required = true, validate(v) => error | '' },
 *   checkbox: { label, checked },
 *   dismissible = true              Esc / ✕ / clicking outside cancel it
 * }
 * Resolves { confirmed: boolean, value?: string, checked?: boolean }.
 */
export function openDialog(opts = {}) {
  return new Promise((resolve) => {
    const type = ICONS[opts.type] ? opts.type : 'primary';
    const id = `dlg${++idSeq}`;
    const isAlert = opts.cancelText === null;
    const dismissible = opts.dismissible !== false;
    const input = opts.input || null;
    const returnFocus = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay';
    overlay.style.zIndex = String(10010 + ++stackDepth * 2); // a dialog opened from a dialog sits on top
    overlay.innerHTML = `
      <form class="dlg dlg-${type}${opts.wide ? ' dlg-wide' : ''}" role="${CAUTIOUS.has(type) ? 'alertdialog' : 'dialog'}" aria-modal="true"
            aria-labelledby="${id}-title" ${opts.message ? `aria-describedby="${id}-msg"` : ''} novalidate>
        ${dismissible ? `<button type="button" class="dlg-close" data-act="cancel" aria-label="Close">${ti('x')}</button>` : ''}
        <div class="dlg-icon">${ti(opts.icon || ICONS[type])}</div>
        <h2 class="dlg-title" id="${id}-title">${esc(opts.title || '')}</h2>
        ${opts.message ? `<div class="dlg-message" id="${id}-msg">${esc(opts.message)}</div>` : ''}
        ${opts.details ? `<pre class="dlg-details">${esc(opts.details)}</pre>` : ''}
        ${input ? `
          <div class="dlg-field">
            ${input.label ? `<label class="dlg-label" for="${id}-input">${esc(input.label)}</label>` : ''}
            <input id="${id}-input" class="dlg-input" type="text" autocomplete="off" spellcheck="false"
                   maxlength="${Number(input.maxlength) || 255}" value="${esc(input.value ?? '')}"
                   placeholder="${esc(input.placeholder || '')}" aria-describedby="${id}-err">
            <div class="dlg-error" id="${id}-err" role="alert"></div>
          </div>` : ''}
        ${(opts.fields || []).map(f => `
          <div class="dlg-field">
            <label class="dlg-label" for="${id}-f-${esc(f.name)}">${esc(f.label || f.name)}</label>
            ${f.type === 'select'
              ? `<select id="${id}-f-${esc(f.name)}" class="dlg-input" data-field="${esc(f.name)}">${fieldOptions(f.options, f.value)}</select>`
              : `<input id="${id}-f-${esc(f.name)}" class="dlg-input" data-field="${esc(f.name)}" type="text" autocomplete="off"
                        spellcheck="false" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">`}
            ${f.hint ? `<div class="dlg-hint">${esc(f.hint)}</div>` : ''}
          </div>`).join('')}
        ${opts.fields ? `<div class="dlg-error" id="${id}-ferr" role="alert"></div>` : ''}
        ${opts.checkbox ? `
          <label class="dlg-check">
            <input type="checkbox" ${opts.checkbox.checked ? 'checked' : ''}>
            <span>${esc(opts.checkbox.label)}</span>
          </label>` : ''}
        <div class="dlg-actions">
          ${isAlert ? '' : `<button type="button" class="btn dlg-cancel" data-act="cancel">${esc(opts.cancelText || 'Cancel')}</button>`}
          <button type="submit" class="btn dlg-confirm">${esc(opts.confirmText || (isAlert ? 'OK' : 'Confirm'))}</button>
        </div>
      </form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form');
    // The prompt's own text box and error line (form fields share the classes, not the ids).
    const field = overlay.querySelector(`#${id}-input`);
    const errorEl = overlay.querySelector(`#${id}-err`);
    const confirmBtn = overlay.querySelector('.dlg-confirm');
    const cancelBtn = overlay.querySelector('.dlg-cancel');
    const required = input ? input.required !== false : false;

    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      stackDepth--;
      overlay.remove();
      if (returnFocus && document.contains(returnFocus) && typeof returnFocus.focus === 'function') {
        returnFocus.focus({ preventScroll: true });
      }
      resolve(result);
    };
    const cancel = () => close({ confirmed: false });

    const problem = () => {
      if (!field) return '';
      const v = field.value.trim();
      if (required && v === '') return 'Enter a value.';
      return typeof input.validate === 'function' ? (input.validate(v) || '') : '';
    };
    const showProblem = (msg) => {
      if (!errorEl) return;
      errorEl.textContent = msg;
      field.classList.toggle('invalid', !!msg);
      field.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };

    // Form fields (opts.fields): read values, enforce required ones, and let the
    // caller react to changes (e.g. reload one select's options from another).
    const fieldEls = () => [...form.querySelectorAll('[data-field]')];
    const readValues = () => Object.fromEntries(fieldEls().map(el => [el.dataset.field, el.value]));
    const fieldApi = {
      get: (name) => form.querySelector(`[data-field="${CSS.escape(name)}"]`)?.value,
      setValue: (name, v) => { const el = form.querySelector(`[data-field="${CSS.escape(name)}"]`); if (el) el.value = v; },
      setOptions: (name, options, selected) => {
        const el = form.querySelector(`[data-field="${CSS.escape(name)}"]`);
        if (el) el.innerHTML = fieldOptions(options, selected);
      }
    };
    if (opts.fields && typeof opts.onFieldChange === 'function') {
      fieldEls().forEach(el => el.addEventListener('change', () => opts.onFieldChange(el.dataset.field, el.value, fieldApi)));
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = problem();
      if (msg) {
        showProblem(msg);
        field.focus();
        return;
      }
      if (opts.fields) {
        const values = readValues();
        const missing = opts.fields.find(f => f.required && String(values[f.name] ?? '').trim() === '');
        const custom = !missing && typeof opts.validate === 'function' ? opts.validate(values) : '';
        const ferr = overlay.querySelector(`#${id}-ferr`);
        if (missing || custom) {
          ferr.textContent = missing ? `${missing.label || missing.name} is required.` : custom;
          (missing ? form.querySelector(`[data-field="${CSS.escape(missing.name)}"]`) : fieldEls()[0])?.focus();
          return;
        }
      }
      const checkbox = overlay.querySelector('.dlg-check input');
      close({
        confirmed: true,
        ...(field ? { value: field.value.trim() } : {}),
        ...(checkbox ? { checked: checkbox.checked } : {}),
        ...(opts.fields ? { values: readValues() } : {})
      });
    });
    overlay.querySelectorAll('[data-act="cancel"]').forEach(b => b.addEventListener('click', cancel));
    if (field) {
      field.addEventListener('input', () => {
        if (errorEl.textContent) showProblem(problem());
        if (required) confirmBtn.disabled = field.value.trim() === '';
      });
      if (required) confirmBtn.disabled = field.value.trim() === '';
    }

    // Clicking the backdrop cancels, except for prompts (don't throw away typing).
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && dismissible && !field) cancel();
    });

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        const items = [...form.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    const firstField = form.querySelector('[data-field]');
    if (field) {
      field.focus();
      field.select();
    } else if (firstField) {
      firstField.focus();
    } else if (CAUTIOUS.has(type) && cancelBtn) {
      cancelBtn.focus();
    } else {
      confirmBtn.focus();
    }
  });
}

// ─── Promise API (mixed into the app, so: this.confirmDialog(...)) ──

/** Resolves true if confirmed, false if cancelled. */
export async function confirmDialog(opts) {
  return (await openDialog(opts)).confirmed;
}

/**
 * Multi-field form. opts: { title, message, fields: [{ name, label, type: 'select' | 'text',
 * options, value, placeholder, hint, required }], onFieldChange(name, value, api), validate(values),
 * confirmText, wide }. Resolves the { name: value } object, or null if cancelled.
 */
export async function formDialog(opts) {
  const r = await openDialog(opts);
  return r.confirmed ? r.values : null;
}

/** One-button message. Resolves when dismissed. */
export async function alertDialog(opts) {
  await openDialog({ type: 'info', ...opts, cancelText: null });
}

/**
 * Text input dialog. opts: { title, message, label, value, placeholder,
 * maxlength, required, validate, checkbox, confirmText }.
 * Resolves { value, checked } or null if cancelled.
 */
export async function promptDialog(opts) {
  const { label, value, placeholder, maxlength, required, validate, ...rest } = opts;
  const r = await openDialog({ ...rest, input: { label, value, placeholder, maxlength, required, validate } });
  return r.confirmed ? { value: r.value, checked: r.checked } : null;
}

// ─── Callback API used throughout the app (wraps the above) ──

/** showConfirmDialog(title, message, onConfirm, { confirmText, cancelText, type, details }) */
export function showConfirmDialog(title, message, onConfirm, options = {}) {
  return this.confirmDialog({ title, message, ...options }).then((ok) => {
    if (ok && typeof onConfirm === 'function') onConfirm();
    return ok;
  });
}

/** showAlertDialog(title, message, 'success' | 'error' | 'info' | 'warning') */
export function showAlertDialog(title, message, type = 'success') {
  return this.alertDialog({ title, message, type, confirmText: 'Dismiss' });
}

/** showPromptDialog(title, { message, label, value, placeholder, checkbox, confirmText }, onSubmit(value, checked)) */
export function showPromptDialog(title, opts, onSubmit) {
  return this.promptDialog({ title, ...opts }).then((r) => {
    if (r) onSubmit(r.value, r.checked);
    return r;
  });
}
