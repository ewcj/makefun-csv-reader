// makefun-csv-reader: a fast drop-in for csv-reader 1.0.0, the reference program of
// make.fun's csv-reader-speed-01. run(input) returns exactly csv-reader's answer for
// the input {text, header}: {columns, rows, errors}.
//
// Written from the published broken-row policy (competition.yaml / RULES.txt):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled ("" is
//     one quote; each CRLF or lone CR inside reads as LF); what follows the closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk,
//     when the field ends); a quote that never closes is a literal character and the
//     text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are padded with
//     "" (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - errors are {code, line, row} in the order met, a record's short_row or long_row
//     when it ends; line is the 1-based line its record starts on (every LF, CRLF and
//     lone CR inside quotes counted), row its record's index in rows (null for the
//     header).
//
// Speed: a record with no quote and no stray CR goes through one native split(',');
// other fields are scanned with native indexOf / RegExp searches instead of one
// character at a time, and quoted spans are sliced whole unless they hold a line
// break. No dependencies, no WebAssembly, no native addons.

const COMMA = 44; // ','
const LF = 10; // '\n'
const CR = 13; // '\r'
const QUOTE = 34; // '"'

// How a field ended: at a comma, at a line break, at the end of the text.
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The next delimiter of an unquoted field (comma, CR or LF), from lastIndex on.
  const delim = /[,\r\n]/g;
  // The next line break inside a quoted span (CR or LF), from lastIndex on.
  const newline = /[\r\n]/g;

  // The record being read: the line it starts on, its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Append text[start..end) to value, turning each CR or CRLF inside into one LF and
  // counting the lines it spans. Most spans hold no line break at all.
  function appendSpan(value, start, end) {
    if (start >= end) return value;
    newline.lastIndex = start;
    const m = newline.exec(text);
    if (m === null || m.index >= end) return value + text.slice(start, end);
    let out = value + text.slice(start, m.index);
    let s = m.index;
    for (;;) {
      line += 1;
      if (text.charCodeAt(s) === CR) {
        out += '\n';
        s += text.charCodeAt(s + 1) === LF ? 2 : 1;
      } else {
        out += '\n';
        s += 1;
      }
      newline.lastIndex = s;
      const n = newline.exec(text);
      if (n === null || n.index >= end) {
        if (s < end) out += text.slice(s, end);
        return out;
      }
      out += text.slice(s, n.index);
      s = n.index;
    }
  }

  // Read an unquoted field from pos, starting from `value` ('' normally; '"' when a
  // quote that never closed is re-read). Returns {value, ended, added}: added counts
  // the characters kept, which the quote_junk rule reads. Used by the quoted paths;
  // the main loop inlines the same scan for plain fields.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    for (;;) {
      delim.lastIndex = start;
      const m = delim.exec(text);
      if (m === null) {
        if (start < len) {
          value += text.slice(start);
          added += len - start;
        }
        pos = len;
        return { value, ended: AT_END, added };
      }
      const d = m.index;
      const c = text.charCodeAt(d);
      if (c === COMMA) {
        if (d > start) {
          value += text.slice(start, d);
          added += d - start;
        }
        pos = d + 1;
        return { value, ended: AT_COMMA, added };
      }
      if (c === LF) {
        if (d > start) {
          value += text.slice(start, d);
          added += d - start;
        }
        pos = d + 1;
        line += 1;
        return { value, ended: AT_BREAK, added };
      }
      if (text.charCodeAt(d + 1) === LF) {
        if (d > start) {
          value += text.slice(start, d);
          added += d - start;
        }
        pos = d + 2;
        line += 1;
        return { value, ended: AT_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (d > start) {
        value += text.slice(start, d);
        added += d - start;
      }
      start = d + 1;
    }
  }

  // Read a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let start = pos + 1;
    let scan = start;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is
        // read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        value = appendSpan(value, start, q) + '"';
        scan = q + 2;
        start = scan;
        continue;
      }
      value = appendSpan(value, start, q);
      pos = q + 1;
      break;
    }
    if (pos >= len) return { value, ended: AT_END };
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      return { value, ended: AT_COMMA };
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      return { value, ended: AT_BREAK };
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      return { value, ended: AT_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma
    // or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast lane: a record with no quote and no stray CR is one native split.
    let fields = null;
    const lf = text.indexOf('\n', pos);
    if (lf !== -1) {
      const q = text.indexOf('"', pos);
      if (q === -1 || q > lf) {
        let end = lf;
        if (text.charCodeAt(lf - 1) === CR) end = lf - 1;
        const cr = text.indexOf('\r', pos);
        if (cr === -1 || cr >= end) {
          fields = text.slice(pos, end).split(',');
          pos = lf + 1;
          line += 1;
        }
      }
    } else {
      const q = text.indexOf('"', pos);
      const cr = text.indexOf('\r', pos);
      if (q === -1 && cr === -1) {
        fields = text.slice(pos).split(',');
        pos = len;
      }
    }

    let quoted = false;
    if (fields === null) {
      fields = [];
      let ended;
      do {
        if (text.charCodeAt(pos) === QUOTE) {
          quoted = true;
          const field = readQuoted();
          ended = field.ended;
          fields.push(field.value);
        } else {
          quoted = false;
          // Plain field, scanned with the delimiter search (inlined: no object).
          let value = '';
          let start = pos;
          for (;;) {
            delim.lastIndex = start;
            const m = delim.exec(text);
            if (m === null) {
              value += text.slice(start);
              pos = len;
              ended = AT_END;
              break;
            }
            const d = m.index;
            const c = text.charCodeAt(d);
            if (c === COMMA) {
              value += text.slice(start, d);
              pos = d + 1;
              ended = AT_COMMA;
              break;
            }
            if (c === LF) {
              value += text.slice(start, d);
              pos = d + 1;
              line += 1;
              ended = AT_BREAK;
              break;
            }
            if (text.charCodeAt(d + 1) === LF) {
              value += text.slice(start, d);
              pos = d + 2;
              line += 1;
              ended = AT_BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            value += text.slice(start, d);
            start = d + 1;
          }
          fields.push(value);
        }
      } while (ended === AT_COMMA);

      // A line that held only stray CRs is left with no characters: no record (its
      // stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
