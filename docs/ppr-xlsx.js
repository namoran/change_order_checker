/* ppr-xlsx.js — minimal, dependency-free-ish .xlsm reader.
 *
 * Reads only the parts of the workbook a tool actually needs, which is what
 * makes it fast: 3 full workbooks take ~80 ms here versus ~1.5 s for a
 * general-purpose parser. Values are the *cached* values Excel stored, which
 * matches openpyxl's data_only=True behaviour that the Python tools relied on.
 * A cell's formula, when it has one, is exposed separately (Sheet.formula):
 * the checker computes the handful of quantity formulas these workbooks
 * carry instead of trusting their cached values, which may be stale.
 *
 * Needs fflate (unzipSync) only.
 */
var PPRXlsx = (function () {
  'use strict';

  var dec = new TextDecoder('utf-8');

  function unxml(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, e) {
      switch (e) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
      }
      if (e[1] === 'x' || e[1] === 'X') return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e[0] === '#') return String.fromCodePoint(parseInt(e.slice(1), 10));
      return m;
    });
  }

  function texts(xml) {
    var out = '';
    var re = /<t\b[^>]*>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(xml))) out += unxml(m[1]);
    return out;
  }

  function unzip(bytes, names) {
    return fflate.unzipSync(bytes, {
      filter: function (f) { return names.indexOf(f.name) !== -1; }
    });
  }

  function Workbook(bytes) {
    var self = this;
    var head = unzip(bytes, [
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml'
    ]);
    if (!head['xl/workbook.xml']) throw new Error('not an .xlsx/.xlsm file (no xl/workbook.xml)');

    var wbXml = dec.decode(head['xl/workbook.xml']);
    var relXml = head['xl/_rels/workbook.xml.rels'] ? dec.decode(head['xl/_rels/workbook.xml.rels']) : '';
    this.workbookXml = wbXml;

    var targets = {};
    relXml.replace(/<Relationship\b([^>]*)\/?>/g, function (m, attrs) {
      var id = /\bId="([^"]+)"/.exec(attrs);
      var tgt = /\bTarget="([^"]+)"/.exec(attrs);
      if (id && tgt) targets[id[1]] = tgt[1].replace(/^\/?(xl\/)?/, '');
    });

    this.names = [];
    this.sheets = {};
    wbXml.replace(/<sheet\b([^>]*)\/?>/g, function (m, attrs) {
      var name = /\bname="([^"]*)"/.exec(attrs);
      var rid = /\br:id="([^"]+)"/.exec(attrs);
      if (!name) return;
      var n = unxml(name[1]);
      self.names.push(n);
      self.sheets[n] = { rId: rid ? rid[1] : null, loaded: null };
    });

    this.shared = [];
    if (head['xl/sharedStrings.xml']) {
      var ss = dec.decode(head['xl/sharedStrings.xml']);
      var re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g, m;
      while ((m = re.exec(ss))) this.shared.push(m[1] ? texts(m[1]) : '');
    }

    this._bytes = bytes;
    this._targets = targets;
  }

  Workbook.prototype.sheet = function (name) {
    var entry = this.sheets[name];
    if (!entry) return null;
    if (!entry.loaded) entry.loaded = new Sheet(this._loadXml(name), this.shared);
    return entry.loaded;
  };

  Workbook.prototype.sheetPath = function (name) {
    var entry = this.sheets[name];
    if (!entry) return null;
    var target = this._targets[entry.rId];
    if (!target) throw new Error('cannot resolve sheet relationship ' + entry.rId);
    return target.indexOf('xl/') === 0 ? target : 'xl/' + target;
  };

  Workbook.prototype._loadXml = function (name) {
    var path = this.sheetPath(name);
    var got = unzip(this._bytes, [path]);
    if (!got[path]) throw new Error('missing worksheet part ' + path);
    return dec.decode(got[path]);
  };

  /* One worksheet. Cells are pulled on demand, by range. */
  function Sheet(xml, shared) {
    this.xml = xml;
    this.shared = shared;
  }

  Sheet.prototype.cellValue = function (body, type) {
    if (body === undefined || body === null) return null;
    if (type === 'inlineStr') return texts(body);

    var v = /<v\b[^>]*>([\s\S]*?)<\/v>|<v\b[^>]*\/>/.exec(body);
    if (!v) return null;
    if (v[1] === undefined) return null;              // <v/> = empty cached value

    var raw = unxml(v[1]);
    if (type === 's') return this.shared[parseInt(raw, 10)] ?? null;
    if (type === 'b') return raw === '1';
    if (type === 'str' || type === 'e') return raw;
    var n = Number(raw);
    return isNaN(n) ? raw : n;
  };

  /* Single cell, without walking the whole sheet. Rows are cached. */
  Sheet.prototype.value = function (row, col) {
    if (!this._rows) this._rows = {};
    var cells = this._rows[row];
    if (!cells) {
      cells = this._rows[row] = {};
      var rowRe = new RegExp('<row\\b[^>]*\\br="' + row + '"[^>]*?(?:/>|>([\\s\\S]*?)<\\/row>)');
      var m = rowRe.exec(this.xml);
      if (m && m[1]) {
        var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c;
        while ((c = cellRe.exec(m[1]))) {
          var ref = /\br="([A-Z]+)\d+"/.exec(c[1]);
          if (!ref) continue;
          var type = /\bt="([^"]+)"/.exec(c[1]);
          cells[colIndex(ref[1])] = this.cellValue(c[2], type ? type[1] : null);
        }
      }
    }
    return cells[col] === undefined ? null : cells[col];
  };

  /* Returns rows x cols matrix of values for the given 1-based range. */
  Sheet.prototype.range = function (minRow, maxRow, minCol, maxCol) {
    var rows = maxRow - minRow + 1;
    var cols = maxCol - minCol + 1;
    var out = new Array(rows);
    for (var i = 0; i < rows; i++) out[i] = new Array(cols).fill(null);

    var rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    var m, r, rowNum;
    while ((m = rowRe.exec(this.xml))) {
      r = /\br="(\d+)"/.exec(m[1]);
      if (!r) continue;
      rowNum = parseInt(r[1], 10);
      if (rowNum < minRow || rowNum > maxRow) continue;
      var body = m[2];
      if (!body) continue;

      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c;
      while ((c = cellRe.exec(body))) {
        var ref = /\br="([A-Z]+)(\d+)"/.exec(c[1]);
        if (!ref) continue;
        var col = colIndex(ref[1]);
        if (col < minCol || col > maxCol) continue;
        var type = /\bt="([^"]+)"/.exec(c[1]);
        out[rowNum - minRow][col - minCol] = this.cellValue(c[2], type ? type[1] : null);
      }
    }
    return out;
  };

  /* Formula text per cell, with shared formulas expanded. Excel stores a
   * shared formula's text once, on its master cell; follower cells carry
   * only the shared index. A follower's formula is the master's with its
   * unanchored references shifted to the follower's position. */
  Sheet.prototype._formulaIndex = function () {
    if (this._fIdx) return this._fIdx;
    var cells = {};    // 'row|col' -> {text} or {si}
    var masters = {};  // si -> {text, row, col}
    var rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, m;
    while ((m = rowRe.exec(this.xml))) {
      var body = m[2];
      if (!body) continue;
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c;
      while ((c = cellRe.exec(body))) {
        var inner = c[2];
        if (!inner) continue;
        var f = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        if (!f) continue;
        var ref = /\br="([A-Z]+)(\d+)"/.exec(c[1]);
        if (!ref) continue;
        var row = parseInt(ref[2], 10), col = colIndex(ref[1]);
        var si = /\bsi="(\d+)"/.exec(f[1]);
        var text = f[2] ? unxml(f[2]) : null;
        if (text) {
          cells[row + '|' + col] = { text: text };
          if (si) masters[si[1]] = { text: text, row: row, col: col };
        } else if (si) {
          cells[row + '|' + col] = { si: si[1] };
        }
      }
    }
    this._fIdx = { cells: cells, masters: masters };
    return this._fIdx;
  };

  /* The formula in a cell, or null when the cell holds a plain value.
   * Returns '' when the cell is a shared-formula follower whose master
   * cannot be found: the cell does hold a formula, but not one that can
   * be reconstructed, so callers must not fall back to the cached value. */
  Sheet.prototype.formula = function (row, col) {
    var idx = this._formulaIndex();
    var e = idx.cells[row + '|' + col];
    if (!e) return null;
    if (e.text) return e.text;
    var master = idx.masters[e.si];
    if (!master) return '';
    return shiftFormula(master.text, col - master.col, row - master.row);
  };

  /* Map of 'row|col' -> formula text for every formula cell in a range. */
  Sheet.prototype.formulasIn = function (minRow, maxRow, minCol, maxCol) {
    var idx = this._formulaIndex();
    var out = {};
    for (var k in idx.cells) {
      var p = k.split('|');
      var row = +p[0], col = +p[1];
      if (row < minRow || row > maxRow || col < minCol || col > maxCol) continue;
      var f = this.formula(row, col);
      if (f !== null) out[k] = f;
    }
    return out;
  };

  Sheet.prototype.maxRow = function () {
    if (this._maxRow) return this._maxRow;
    var max = 0, re = /<row\b[^>]*\br="(\d+)"/g, m;
    while ((m = re.exec(this.xml))) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
    return (this._maxRow = max);
  };

  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function colName(n) {
    var s = '';
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = (n - 1 - r) / 26;
    }
    return s;
  }

  /* Shift the cell references in a formula by (dCol, dRow), the way Excel
   * expands a shared formula from its master cell to a follower cell:
   * references anchored with $ do not move. Quoted strings are untouched. */
  function shiftFormula(text, dCol, dRow) {
    if (!dCol && !dRow) return text;
    var parts = text.split(/("(?:[^"]|"")*")/);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i]
        .replace(/(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)/g, function (m, pre, d1, letters, d2, digits) {
          var col = letters, row = digits;
          if (!d1) {
            var ci = colIndex(letters) + dCol;
            if (ci >= 1) col = colName(ci);
          }
          if (!d2) row = String(parseInt(digits, 10) + dRow);
          return pre + d1 + col + d2 + row;
        })
        .replace(/(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})/g, function (m, pre, d1, c1, d2, c2) {
          var a = d1 ? d1 + c1 : colName(colIndex(c1) + dCol);
          var b = d2 ? d2 + c2 : colName(colIndex(c2) + dCol);
          return pre + a + ':' + b;
        });
    }
    return parts.join('');
  }

  function open(bytes) { return new Workbook(bytes); }

  return { open: open, colIndex: colIndex };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PPRXlsx;
