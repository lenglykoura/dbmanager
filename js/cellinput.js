// How to edit a value of a given MySQL column type: which <input> to use (so
// dates get the browser's date / time picker), how to turn the stored value into
// the input's value, and how to validate and normalise what was typed before it
// is sent to MySQL. Shared by the Browse grid and the Insert Row form.
//
// columnInputSpec(colDef) returns null for types that keep plain text editing.
// spec.toInput(value) returns undefined when a stored value can't be shown in
// the typed input (e.g. TIME '100:00:00'); callers then fall back to text.
// spec.parse(raw) -> { ok: true, value } | { ok: false, error }. An empty string
// stays '' so the caller can decide between NULL, the default and "required".

const INT_RANGES = {
  tinyint: [-128n, 127n, 255n],
  smallint: [-32768n, 32767n, 65535n],
  mediumint: [-8388608n, 8388607n, 16777215n],
  int: [-2147483648n, 2147483647n, 4294967295n],
  integer: [-2147483648n, 2147483647n, 4294967295n],
  bigint: [-9223372036854775808n, 9223372036854775807n, 18446744073709551615n]
};

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });
const isZeroDate = (v) => /^0000-00-00/.test(String(v));

/** "1,234,567.5" / "1 234 567.5" → "1234567.5" (people paste grouped numbers). */
const ungroup = (raw) => String(raw).trim().replace(/[,\s_]/g, '');

export function columnInputSpec(colDef) {
  const t = String(colDef?.t || '').toLowerCase().trim();
  const unsigned = /\bunsigned\b/.test(t);
  let m;

  // DATE
  if (/^date\b/.test(t)) {
    return {
      kind: 'date', type: 'date', picker: true,
      hint: 'Date (YYYY-MM-DD)',
      toInput: (v) => (isZeroDate(v) ? '' : String(v).slice(0, 10)),
      parse: (raw) => {
        const s = String(raw).trim();
        if (s === '') return ok('');
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? ok(s) : fail('Use the format YYYY-MM-DD.');
      }
    };
  }

  // DATETIME / TIMESTAMP, with optional fractional seconds: datetime(3)
  if ((m = t.match(/^(datetime|timestamp)(?:\((\d)\))?/))) {
    const fsp = Number(m[2] || 0);
    return {
      kind: 'datetime', type: 'datetime-local', picker: true,
      attrs: { step: fsp ? String(1 / 10 ** fsp) : '1' },
      hint: `${m[1].toUpperCase()} (date and time${fsp ? `, ${fsp} decimal seconds` : ''})`,
      toInput: (v) => {
        if (isZeroDate(v)) return '';
        const s = String(v).replace(' ', 'T');
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s : undefined;
      },
      parse: (raw) => {
        const s = String(raw).trim();
        if (s === '') return ok('');
        const p = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
        if (!p) return fail('Pick a date and a time.');
        // The browser drops ":00" seconds; MySQL wants the full value back.
        let out = `${p[1]} ${p[2]}:${p[3] || '00'}`;
        if (fsp) out += '.' + (p[4] || '').slice(0, fsp).padEnd(fsp, '0');
        return ok(out);
      }
    };
  }

  // TIME — only within a day; MySQL also allows e.g. '-12:00:00' or '838:59:59'.
  if ((m = t.match(/^time(?:\((\d)\))?/))) {
    const fsp = Number(m[1] || 0);
    return {
      kind: 'time', type: 'time', picker: true,
      attrs: { step: fsp ? String(1 / 10 ** fsp) : '1' },
      hint: 'Time (HH:MM:SS)',
      toInput: (v) => (/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(String(v)) ? String(v) : undefined),
      parse: (raw) => {
        const s = String(raw).trim();
        if (s === '') return ok('');
        const p = s.match(/^(\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
        if (!p) return fail('Use the format HH:MM:SS.');
        let out = `${p[1]}:${p[2] || '00'}`;
        if (fsp) out += '.' + (p[3] || '').slice(0, fsp).padEnd(fsp, '0');
        return ok(out);
      }
    };
  }

  // YEAR
  if (/^year\b/.test(t)) {
    return {
      kind: 'year', type: 'text', attrs: { inputmode: 'numeric', maxlength: '4' },
      hint: 'YEAR (1901–2155)',
      toInput: (v) => String(v),
      parse: (raw) => {
        const s = String(raw).trim();
        if (s === '') return ok('');
        if (!/^\d{4}$/.test(s)) return fail('Enter a 4-digit year.');
        const y = Number(s);
        return (y >= 1901 && y <= 2155) || y === 0 ? ok(s) : fail('YEAR must be between 1901 and 2155.');
      }
    };
  }

  // DECIMAL(M,D) / NUMERIC(M,D): exact numbers with a fixed number of decimals.
  if ((m = t.match(/^(decimal|numeric|dec|fixed)(?:\((\d+)(?:,\s*(\d+))?\))?/))) {
    const precision = Number(m[2] || 10);
    const scale = Number(m[3] || 0);
    const intDigits = precision - scale;
    return {
      kind: 'decimal', type: 'text', attrs: { inputmode: 'decimal', autocomplete: 'off' },
      hint: `DECIMAL(${precision},${scale}): up to ${intDigits} digit${intDigits === 1 ? '' : 's'}`
        + (scale ? ` and ${scale} decimal${scale === 1 ? '' : 's'}` : ', no decimals') + (unsigned ? ', not negative' : ''),
      toInput: (v) => String(v),
      parse: (raw) => {
        const s = ungroup(raw);
        if (s === '') return ok('');
        const p = s.match(/^([+-])?(\d*)(?:\.(\d*))?$/);
        if (!p || (p[2] === '' && (p[3] || '') === '')) return fail('Enter a number, e.g. ' + (scale ? `1500.${'0'.repeat(scale)}` : '1500') + '.');
        const intPart = p[2].replace(/^0+(?=\d)/, '') || '0';
        const frac = p[3] || '';
        const negative = p[1] === '-' && /[1-9]/.test(intPart + frac);
        if (negative && unsigned) return fail('This column is UNSIGNED and cannot be negative.');
        if (frac.length > scale) {
          return fail(scale ? `At most ${scale} decimal place${scale === 1 ? '' : 's'}.` : 'Whole numbers only (no decimals).');
        }
        if (intPart !== '0' && intPart.length > intDigits) {
          return fail(`Too large: at most ${intDigits} digit${intDigits === 1 ? '' : 's'} before the decimal point.`);
        }
        // Store it the way MySQL shows it, so the grid matches after saving.
        return ok((negative ? '-' : '') + intPart + (scale ? '.' + frac.padEnd(scale, '0') : ''));
      }
    };
  }

  // FLOAT / DOUBLE / REAL: approximate numbers, exponents allowed.
  if (/^(float|double|real)\b/.test(t)) {
    return {
      kind: 'float', type: 'text', attrs: { inputmode: 'decimal', autocomplete: 'off' },
      hint: `${t.split(/[\s(]/)[0].toUpperCase()} number${unsigned ? ', not negative' : ''}`,
      toInput: (v) => String(v),
      parse: (raw) => {
        const s = ungroup(raw);
        if (s === '') return ok('');
        if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) || !Number.isFinite(Number(s))) return fail('Enter a number.');
        if (unsigned && Number(s) < 0) return fail('This column is UNSIGNED and cannot be negative.');
        return ok(s);
      }
    };
  }

  // Integers, range-checked with BigInt so BIGINT values stay exact.
  if ((m = t.match(/^(tinyint|smallint|mediumint|int|integer|bigint)\b/))) {
    const [min, max, umax] = INT_RANGES[m[1]];
    const lo = unsigned ? 0n : min;
    const hi = unsigned ? umax : max;
    return {
      kind: 'integer', type: 'text', attrs: { inputmode: 'numeric', autocomplete: 'off' },
      hint: `${m[1].toUpperCase()}${unsigned ? ' UNSIGNED' : ''}: ${lo} to ${hi}`,
      toInput: (v) => String(v),
      parse: (raw) => {
        const s = ungroup(raw);
        if (s === '') return ok('');
        if (!/^[+-]?\d+$/.test(s)) return fail('Whole numbers only.');
        const n = BigInt(s);
        if (n < lo || n > hi) return fail(`Out of range: ${lo} to ${hi}.`);
        return ok(n.toString());
      }
    };
  }

  return null;
}
