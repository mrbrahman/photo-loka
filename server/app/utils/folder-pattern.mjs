// Two-way moustache-style pattern engine for collection folder layouts.
//
// Patterns mix literal text (including '/') with tokens wrapped in double
// braces. The engine handles formatting (values + pattern -> string) and
// parsing (string + pattern -> values). It is intentionally minimal and
// deliberately one-way for the common path: the database stores
// album_date and album_name as separate columns, so the on-disk folder
// path is always built forward by format(). parse() is only used during
// initial inPlace indexing of a file whose metadata we don't already
// have in the row.
//
// Supported tokens:
//   {{yyyy}}    4-digit year
//   {{yy}}      2-digit year (interprets as 20yy on parse)
//   {{mm}}      2-digit month
//   {{dd}}      2-digit day
//   {{album}}   album name (string). Greedy: matches the rest of the
//               input including '/', so nested album names work. Must be
//               the LAST token in the pattern.
//
// Example:
//   pattern: '{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}'
//   format({yyyy: 2021, mm: '01', dd: '01', album: 'New Year'})
//     -> '2021/2021-01-01 New Year'
//   parse('2021/2021-01-01 New Year/WhatsApp Images')
//     -> {yyyy: '2021', mm: '01', dd: '01', album: 'New Year/WhatsApp Images'}

const TOKEN_RE = /\{\{(yyyy|yy|mm|dd|album)\}\}/g;

const TOKEN_REGEX_FRAGMENT = {
  yyyy:  '(\\d{4})',
  yy:    '(\\d{2})',
  mm:    '(\\d{2})',
  dd:    '(\\d{2})',
  album: '(.*)'
};

const TOKEN_FORMAT_WIDTH = {
  yyyy: 4,
  yy:   2,
  mm:   2,
  dd:   2
};

// Parse a pattern into a list of segments: {kind: 'literal' | 'token', value}.
function tokenize(pattern) {
  const segments = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(pattern)) !== null) {
    if (m.index > last) {
      segments.push({ kind: 'literal', value: pattern.slice(last, m.index) });
    }
    segments.push({ kind: 'token', value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < pattern.length) {
    segments.push({ kind: 'literal', value: pattern.slice(last) });
  }
  return segments;
}

// Validate that {{album}}, if present, is the last token in the pattern.
// Reason: parse() uses a greedy regex (.*) for {{album}} so it can capture
// nested album names like 'New Year/WhatsApp Images'. If {{album}} were not
// last, that greedy match would swallow everything after it and break the
// rest of the pattern. Anything after {{album}} must be literal whitespace
// or punctuation only (which we trim during format when album is empty).
function validate(pattern) {
  const segments = tokenize(pattern);
  const tokenIdxs = segments.map((s, i) => s.kind === 'token' ? i : -1).filter(i => i >= 0);
  const albumIdx = segments.findIndex(s => s.kind === 'token' && s.value === 'album');
  if (albumIdx !== -1 && albumIdx !== tokenIdxs[tokenIdxs.length - 1]) {
    throw new Error(`Pattern '${pattern}': {{album}} must be the last token`);
  }
}

/**
 * Format a values object into a string using the pattern.
 * Numeric tokens (yyyy, yy, mm, dd) get zero-padded to fixed width.
 * If {{album}} resolves to an empty string, trailing whitespace immediately
 * before it (within the same path segment) is trimmed so we don't get
 * stray '... ' folder names.
 */
export function format(values, pattern) {
  validate(pattern);
  const segments = tokenize(pattern);

  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 'literal') {
      out += seg.value;
      continue;
    }
    let raw = values[seg.value];
    if (seg.value === 'album') {
      raw = (raw == null ? '' : String(raw)).trim();
      if (raw === '') {
        // Trim trailing whitespace from the literal we just wrote so we
        // don't leave a 'YYYY-MM-DD ' kind of name. Don't trim across '/'.
        out = out.replace(/[ \t]+$/, '');
        continue;
      }
      out += raw;
      continue;
    }
    // Numeric token: zero-pad to fixed width.
    const width = TOKEN_FORMAT_WIDTH[seg.value];
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new Error(`format: missing or non-numeric value for {{${seg.value}}}`);
    out += String(num).padStart(width, '0');
  }
  return out;
}

/**
 * Parse a string into a values object using the pattern. Returns null if
 * the string doesn't match the pattern. {{album}} matches greedily and may
 * include '/' for nested album names; an empty match is allowed.
 */
export function parse(input, pattern) {
  validate(pattern);
  const segments = tokenize(pattern);

  let regexStr = '^';
  const tokenOrder = [];
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      regexStr += escapeRegex(seg.value);
    } else {
      regexStr += TOKEN_REGEX_FRAGMENT[seg.value];
      tokenOrder.push(seg.value);
    }
  }
  regexStr += '$';

  const m = new RegExp(regexStr).exec(input);
  if (!m) return null;

  const values = {};
  tokenOrder.forEach((tok, i) => {
    values[tok] = m[i + 1];
  });

  // Year normalization for {{yy}}: interpret as 20yy. Callers can override
  // if they need different century logic.
  if (values.yy != null && values.yyyy == null) {
    values.yyyy = `20${values.yy}`;
  }
  return values;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
