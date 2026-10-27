/* PRP Change Order Package Checker — spreadsheet logic.
 *
 * A straight port of comparenew_spi_to_rfc.py. Keep the two in sync: the
 * Python version is what runs on Streamlit, this one runs in the browser.
 *
 * Depends on PPRXlsx (ppr-xlsx.js) for reading. No DOM access, so it
 * can be tested under Node. Pay items are matched by the labels printed
 * in each workbook -- there is no built-in pay item list.
 */
var COC = (function () {
  'use strict';

  var RFC_SHEET = 'RFC';
  var SOW_SHEET = 'SOW Units';
  var RFC_FIRST_ROW = 12;   // openpyxl min_row=12
  var RFC_LAST_ROW = 111;   // openpyxl max_row=111

  /* Python's str() on a number: 300 -> "300", 1.5 -> "1.5". */
  function fmt(v) {
    if (v === null || v === undefined) return 'None';
    return String(v);
  }

  function asNumber(v) {
    return v === null ? 0 : v;
  }

  var LABEL_RE = /^\d{1,2}([-.][0-9A-Za-z]+)*\.$/;

  /* Locate the pay item table in an SOW Units sheet from the workbook
   * itself. The header row carries a 'PAY ITEM' cell and the 'TASK n
   * QUANT.' column headers; pay item labels run down the PAY ITEM
   * column below the header, ending at the totals/version block.
   * Throws when the table cannot be found -- positions are never
   * guessed, because a workbook from a different SPI version has
   * different rows (Version 10.0, for example, has no section 22, so
   * section 23 sits 31 rows above where a fixed list would look).
   * Mirrors spi_layout in the Python version. */
  function spiLayout(sheet) {
    var scan = sheet.range(1, 40, 1, 24);
    var hr = -1, lc = -1;
    for (var i = 0; i < scan.length && hr < 0; i++) {
      for (var j = 0; j < scan[i].length; j++) {
        var v = scan[i][j];
        if (typeof v === 'string' && v.trim().toLowerCase() === 'pay item') { hr = i + 1; lc = j + 1; break; }
      }
    }
    if (hr < 0) {
      throw new Error('no pay item table found in the SPI workbook: ' +
                      'no "PAY ITEM" header cell in the SOW Units sheet');
    }
    var taskCols = {};
    for (var r = Math.max(1, hr - 1); r <= hr + 1; r++) {
      for (var c = 1; c <= 24; c++) {
        var hv = sheet.value(r, c);
        if (typeof hv === 'string') {
          var m = /TASK\s*(\d+)/i.exec(hv);
          if (m) taskCols[parseInt(m[1], 10)] = c;
        }
      }
    }
    if (!Object.keys(taskCols).length) {
      throw new Error('no task quantity columns found in the SPI workbook');
    }
    var colVals = sheet.range(hr + 1, hr + 800, lc, lc);
    var labels = [], rows = {}, started = false, misses = 0;
    for (var k = 0; k < colVals.length; k++) {
      var raw = colVals[k][0];
      var s = raw === null || raw === undefined ? '' : String(raw).trim();
      if (LABEL_RE.test(s)) {
        started = true; misses = 0;
        if (!(s in rows)) { rows[s] = hr + 1 + k; labels.push(s); }
      } else if (started) {
        if (++misses >= 10) break;
      }
    }
    if (labels.length < 10) {
      throw new Error('only ' + labels.length + ' pay items found in the SPI workbook');
    }
    return { labels: labels, rows: rows, taskCols: taskCols };
  }

  /* Every task quantity in the table: {label + NUL + task number: value}. */
  function quantities(sheet, layout) {
    var tcols = Object.keys(layout.taskCols).map(Number);
    var colNums = tcols.map(function (t) { return layout.taskCols[t]; });
    var lo = Math.min.apply(null, colNums), hi = Math.max.apply(null, colNums);
    var inv = {};
    tcols.forEach(function (t) { inv[layout.taskCols[t]] = t; });
    var rowNums = layout.labels.map(function (l) { return layout.rows[l]; });
    var first = Math.min.apply(null, rowNums), last = Math.max.apply(null, rowNums);
    var byRow = {};
    layout.labels.forEach(function (l) { byRow[layout.rows[l]] = l; });
    var grid = sheet.range(first, last, lo, hi);
    var out = {};
    for (var i = 0; i < grid.length; i++) {
      var label = byRow[first + i];
      if (!label) continue;
      for (var j = 0; j < grid[i].length; j++) {
        var t = inv[lo + j], v = grid[i][j];
        if (t !== undefined && v !== null) out[label + '\u0000' + t] = v;
      }
    }
    return out;
  }

  /* Label order for sorting and comparing: the new SPI's workbook
   * order, then any labels only the old SPI carries, in its order. */
  function spiOrder(oldSheet, newSheet) {
    var oldLayout = spiLayout(oldSheet);
    var newLayout = spiLayout(newSheet);
    var order = newLayout.labels.slice();
    oldLayout.labels.forEach(function (l) { if (!(l in newLayout.rows)) order.push(l); });
    var rank = {};
    order.forEach(function (l, i) { rank[l] = i; });
    return { oldLayout: oldLayout, newLayout: newLayout, order: order, rank: rank };
  }

  /* Sort key shared by the RFC aggregate and the SPI difference so the
   * two lists line up: workbook label order first, then task number.
   * Items missing from the SPI rank after all workbook items. */
  function orderKey(rank, task, pi) {
    var tnum = parseInt(String(task).split(' ').pop(), 10);
    if (rank && (pi in rank)) return [rank[pi], tnum, ''];
    return [1000000, tnum, pi];
  }

  function sortByRank(items, rank) {
    items.sort(function (a, b) {
      var ka = orderKey(rank, a[0], a[1]), kb = orderKey(rank, b[0], b[1]);
      for (var i = 0; i < 3; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
    return items;
  }

  /* Rows of the RFC sheet that actually carry a quantity. */
  function loadRfc(sheet) {
    var m = sheet.range(RFC_FIRST_ROW, RFC_LAST_ROW, 1, 9);
    var out = [];
    for (var i = 0; i < m.length; i++) {
      var task = m[i][0];
      var units = m[i][7];
      if (task === null || units === 0) continue;   // Python: A is not None and H != 0
      out.push(['TASK ' + fmt(task), String(m[i][1]), units]);
    }
    out.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return asNumber(a[2]) - asNumber(b[2]);
    });
    return out;
  }

  /* Difference between the old and new SPI. Items are matched by the
   * pay item labels printed in each workbook, so the two workbooks do
   * not need the same rows or the same SPI version. */
  function getSpiDiff(oldSheet, newSheet) {
    var so = spiOrder(oldSheet, newSheet);
    var oldQ = quantities(oldSheet, so.oldLayout);
    var newQ = quantities(newSheet, so.newLayout);
    var out = [];
    so.order.forEach(function (pi) {
      for (var tnum = 1; tnum <= 10; tnum++) {
        var k = pi + '\u0000' + tnum;
        var oldVal = k in oldQ ? oldQ[k] : 0;
        var newVal = k in newQ ? newQ[k] : 0;
        if (oldVal !== newVal) {
          // Round the difference to 6 decimal places, the same
          // normalization aggregateRfc applies to the RFC side. The raw
          // subtraction is a binary float: 5923.6 - 7000 comes out as
          // -1076.3999999999996, which never equals the RFC's -1076.4
          // under exact comparison and falsely rejects a valid package.
          // A difference that rounds to zero at 6 decimals is float
          // noise, so it is omitted, mirroring how aggregateRfc drops
          // net-zero totals. Mirrors get_spi_diff in the Python version.
          var delta = round6(newVal - oldVal);
          if (delta !== 0) out.push(['TASK ' + tnum, pi, delta]);
        }
      }
    });
    return sortByRank(out, so.rank);
  }

  function key(item) { return item[0] + '\u0000' + item[1] + '\u0000' + fmt(item[2]); }

  function contains(list, item) {
    var k = key(item);
    for (var i = 0; i < list.length; i++) if (key(list[i]) === k) return true;
    return false;
  }

  /* Python round(x, 6) plus int normalization, so combined totals print
   * and compare the way the Python version's do. */
  function round6(v) {
    var r = Math.round(v * 1e6) / 1e6;
    return r === 0 ? 0 : r;
  }

  /* An RFC can list the same pay item more than once in a task -- for
   * example a negative line removing a placeholder amount and a positive
   * line entering the actual quoted amount. FDEP's consistency rule is on
   * the net effect (the new SPI total equals the previous total plus the
   * RFC total), so combine lines for the same task and pay item into one
   * total before comparing to the SPI difference. Mirrors aggregate_rfc
   * in the Python version. */
  function aggregateRfc(items, rank) {
    var totals = {}, counts = {}, keys = [];
    items.forEach(function (it) {
      var k = it[0] + '\u0000' + it[1];
      if (!(k in totals)) { totals[k] = 0; counts[k] = 0; keys.push([it[0], it[1]]); }
      totals[k] += asNumber(it[2]);
      counts[k] += 1;
    });
    keys.sort(function (a, b) {
      var ka = orderKey(rank, a[0], a[1]), kb = orderKey(rank, b[0], b[1]);
      for (var i = 0; i < 3; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
    var agg = [], notes = [];
    keys.forEach(function (tp) {
      var k = tp[0] + '\u0000' + tp[1];
      var units = round6(totals[k]);
      if (counts[k] > 1) {
        notes.push('- note: ' + counts[k] + ' rfc lines for ' + tp[0] + ' pay item ' + tp[1] +
                   ' were combined into one total of ' + fmt(units) + ' units');
      }
      if (units !== 0) agg.push([tp[0], tp[1], units]);
    });
    return { items: sortByRank(agg, rank), notes: notes };
  }

  function generateReport(rfcSheet, oldSheet, newSheet) {
    var rank = spiOrder(oldSheet, newSheet).rank;
    var agg = aggregateRfc(loadRfc(rfcSheet), rank);
    var rfcDump = agg.items;
    var spiDelta = getSpiDiff(oldSheet, newSheet);
    var lines = [];

    if (rfcDump.length === spiDelta.length && rfcDump.every(function (it) { return contains(spiDelta, it); })) {
      lines.push('### Success!!');
      lines.push('#### RFC items were transferred to new SPI');
      agg.notes.forEach(function (n) { lines.push(n); });
      return { success: true, lines: lines, rfcItems: rfcDump, spiItems: spiDelta };
    }

    lines.push('### This rfc package is incorrect !');
    lines.push('#### The following items need attention:');
    agg.notes.forEach(function (n) { lines.push(n); });

    if (rfcDump.length !== spiDelta.length) {
      lines.push("- number of items in rfc don't match new spi");
      if (rfcDump.length > spiDelta.length) {
        lines.push('- rfc contains ' + (rfcDump.length - spiDelta.length) + ' items that arent in the new spi');
      }
      if (rfcDump.length < spiDelta.length) {
        lines.push('- spi contains ' + (spiDelta.length - rfcDump.length) + ' items that arent in the rfc');
      }
    }

    rfcDump.forEach(function (it) {
      if (!contains(spiDelta, it)) {
        lines.push('- rfc line item for ' + it[0] + ' pay item ' + it[1] + ', ' + fmt(it[2]) +
                   ' units does not appear in the new spi');
      }
    });

    spiDelta.forEach(function (it) {
      if (!contains(rfcDump, it)) {
        lines.push('- spi line item for ' + it[0] + ' pay item ' + it[1] + ', ' + fmt(it[2]) +
                   ' units does not appear in the rfc');
      }
    });

    return { success: false, lines: lines, rfcItems: rfcDump, spiItems: spiDelta };
  }

  function requireSheet(wb, name, label) {
    var ws = wb.sheet(name);
    if (!ws) {
      throw new Error(label + ' has no "' + name + '" sheet. Sheets found: ' + wb.names.join(', '));
    }
    return ws;
  }

  function open(buffer, label) {
    try {
      return PPRXlsx.open(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
    } catch (e) {
      throw new Error('Could not read ' + label + ': ' + e.message);
    }
  }

  function analyze(rfcBuffer, oldBuffer, newBuffer) {
    var rfc = requireSheet(open(rfcBuffer, 'the RFC file'), RFC_SHEET, 'the RFC file');
    var oldSpi = requireSheet(open(oldBuffer, 'the old SPI'), SOW_SHEET, 'the old SPI');
    var newSpi = requireSheet(open(newBuffer, 'the new SPI'), SOW_SHEET, 'the new SPI');
    return generateReport(rfc, oldSpi, newSpi);
  }

  return {
    analyze: analyze,
    loadRfc: loadRfc,
    getSpiDiff: getSpiDiff,
    generateReport: generateReport,
    open: open
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = COC;
