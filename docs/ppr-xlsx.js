/* ppr-xlsx.js — minimal, dependency-free-ish .xlsm reader.
 *
 * Reads only the parts of the workbook a tool actually needs, which is what
 * makes it fast: 3 full workbooks take ~80 ms here versus ~1.5 s for a
 * general-purpose parser. Values are the *cached* values Excel stored, which
 * matches openpyxl's data_only=True behaviour that the Python tools relied on.
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

  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function open(bytes) { return new Workbook(bytes); }

  return { open: open, colIndex: colIndex };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PPRXlsx;
