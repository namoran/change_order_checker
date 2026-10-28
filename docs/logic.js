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

  /* Every task quantity in the table: {label + NUL + task number: value},
   * plus the keys whose quantity is a formula this checker cannot
   * compute. A formula cell's value is its computed value, never its
   * cached value (see the formula section below). */
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
    var unverified = {};
    var fmap = sheet.formulasIn(first, last, lo, hi);
    Object.keys(fmap).forEach(function (rk) {
      var p = rk.split('|');
      var row = +p[0], col = +p[1];
      var label = byRow[row], t = inv[col];
      if (!label || t === undefined) return;
      var key = label + '\u0000' + t;
      var res = resolvedValue(sheet, row, col, 0, {});
      if (res.ok && typeof res.value === 'number') out[key] = res.value;
      else if (res.ok) delete out[key];
      else { delete out[key]; unverified[key] = true; }
    });
    return { values: out, unverified: unverified };
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

  /* ---- Formula quantities -------------------------------------------------
   * A few quantity cells in these workbooks hold formulas instead of typed
   * numbers -- the 1-7. handling fee in the SPI (a SUMIF over the task's
   * reimbursable items) and the fee table in the RFC (a SUMIFS over the
   * RFC's reimbursable lines). The reader supplies only the cached values
   * Excel last saved, and a generated SPI keeps the old SPI's cache, so
   * comparing caches fails correct packages and passes doctored ones.
   * Instead, a formula cell's value is computed from the sheet's own data.
   * Only the SUMIF/SUMIFS shapes are computed; anything else is reported
   * as unverified by the callers -- a cached value is never substituted,
   * because a stale or doctored cache is exactly what this replaces. */

  var EVAL_DEPTH = 4;

  /* Split a formula argument list on its top-level commas. */
  function splitArgs(s) {
    var out = [], depth = 0, cur = '', inStr = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inStr) {
        cur += ch;
        if (ch === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; } else inStr = false;
        }
        continue;
      }
      if (ch === '"') { inStr = true; cur += ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (a) { return a.trim(); });
  }

  /* A1-style range: 'I11:I500', '$E$11:$E$500', a full column 'H:H', or a
   * single cell. r2 is Infinity for a full column; callers cap it at the
   * sheet's last row. */
  function parseRange(s) {
    var m = /^\$?([A-Z]{1,3})\$?(\d+)?(?::\$?([A-Z]{1,3})\$?(\d+)?)?$/
      .exec(s.replace(/\s+/g, '').toUpperCase());
    if (!m) return null;
    if (m[3] && !!m[2] !== !!m[4]) return null;   // mixed 'A1:B' forms
    var c1 = PPRXlsx.colIndex(m[1]);
    var r1 = m[2] ? parseInt(m[2], 10) : 1;
    var c2 = m[3] ? PPRXlsx.colIndex(m[3]) : c1;
    var r2 = m[4] ? parseInt(m[4], 10) : (m[3] ? Infinity : r1);
    return { c1: c1, r1: r1, c2: c2, r2: r2 };
  }

  function escapeRe(ch) { return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* Excel criterion text to a matcher: case-insensitive, * and ? are
   * wildcards, ~ escapes them. Comparison criteria ('>=5' and the like)
   * are not supported and return null. */
  function parseCriterion(raw) {
    raw = raw.trim();
    if (/^"[\s\S]*"$/.test(raw)) {
      var s = raw.slice(1, -1).replace(/""/g, '"');
      if (/^[<>=]/.test(s)) return null;
      var out = '';
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (ch === '~' && i + 1 < s.length && '*?~'.indexOf(s[i + 1]) >= 0) out += escapeRe(s[++i]);
        else if (ch === '*') out += '.*';
        else if (ch === '?') out += '.';
        else out += escapeRe(ch);
      }
      return { kind: 'text', re: new RegExp('^' + out + '$', 'i') };
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) return { kind: 'num', value: parseFloat(raw) };
    return null;
  }

  function criterionMatches(crit, value) {
    if (crit.kind === 'num') return typeof value === 'number' && value === crit.value;
    return typeof value === 'string' && crit.re.test(value);
  }

  /* The value of a cell: a plain value as stored, a formula computed.
   * Returns {ok:false} when a formula cannot be computed. */
  function resolvedValue(sheet, row, col, depth, visiting) {
    var f = sheet.formula(row, col);
    if (f === null) return { ok: true, value: sheet.value(row, col) };
    if (depth >= EVAL_DEPTH) return { ok: false };
    var key = row + '|' + col;
    if (visiting[key]) return { ok: false };
    visiting[key] = true;
    var r = evalFormula(sheet, f, depth + 1, visiting);
    delete visiting[key];
    return r;
  }

  function resolvedGridValue(sheet, g, dr, dc, depth, visiting) {
    var row = g.r1 + dr, col = g.c1 + dc;
    if (sheet.formula(row, col) !== null) return resolvedValue(sheet, row, col, depth, visiting);
    return { ok: true, value: g.grid[dr][dc] };
  }

  /* Compute a SUMIF/SUMIFS formula from the sheet's own cells, following
   * Excel's semantics for the parts these workbooks use: criteria ranges
   * and the sum range must cover the same extent, a text criterion
   * matches case-insensitively with wildcards, and only numeric values
   * in the sum range are added. */
  function evalFormula(sheet, text, depth, visiting) {
    var m = /^\s*(SUMIFS?)\s*\(([\s\S]*)\)\s*$/i.exec(text);
    if (!m) return { ok: false };
    var args = splitArgs(m[2]);
    var sumArg, pairArgs;
    if (m[1].toUpperCase() === 'SUMIFS') {
      if (args.length < 3 || args.length % 2 === 0) return { ok: false };
      sumArg = args[0];
      pairArgs = args.slice(1);
    } else {
      if (args.length < 2 || args.length > 3) return { ok: false };
      pairArgs = [args[0], args[1]];
      sumArg = args.length === 3 ? args[2] : args[0];
    }
    var sumRange = parseRange(sumArg);
    if (!sumRange) return { ok: false };
    var crits = [];
    for (var i = 0; i < pairArgs.length; i += 2) {
      var cr = parseRange(pairArgs[i]);
      var cm = parseCriterion(pairArgs[i + 1]);
      if (!cr || !cm) return { ok: false };
      crits.push({ range: cr, match: cm });
    }
    var maxR = sheet.maxRow();
    function cap(r) {
      return { c1: r.c1, r1: r.r1, c2: r.c2, r2: Math.min(r.r2, maxR) };
    }
    var base = cap(crits[0].range);
    var rows = base.r2 - base.r1 + 1, cols = base.c2 - base.c1 + 1;
    if (rows <= 0 || cols <= 0) return { ok: false };
    var sr = cap(sumRange);
    if (sr.r1 === sr.r2 && sr.c1 === sr.c2 && (rows > 1 || cols > 1)) {
      // SUMIF with a single-cell sum range: Excel expands it to the
      // criteria range's extent from that corner.
      sr = { c1: sr.c1, r1: sr.r1, c2: sr.c1 + cols - 1, r2: sr.r1 + rows - 1 };
    }
    if (sr.r2 - sr.r1 + 1 !== rows || sr.c2 - sr.c1 + 1 !== cols) return { ok: false };
    var critGrids = [];
    for (i = 0; i < crits.length; i++) {
      var crg = cap(crits[i].range);
      if (crg.r2 - crg.r1 + 1 !== rows || crg.c2 - crg.c1 + 1 !== cols) return { ok: false };
      critGrids.push({ grid: sheet.range(crg.r1, crg.r2, crg.c1, crg.c2), r1: crg.r1, c1: crg.c1 });
    }
    var sumGrid = { grid: sheet.range(sr.r1, sr.r2, sr.c1, sr.c2), r1: sr.r1, c1: sr.c1 };
    var total = 0;
    for (var dr = 0; dr < rows; dr++) {
      for (var dc = 0; dc < cols; dc++) {
        var all = true;
        for (var k = 0; k < crits.length; k++) {
          // Criteria are matched on the stored value. A criteria cell
          // can hold an unrelated display formula (the RFC sheet's
          // header cells pull facility data with IF formulas); what a
          // criterion needs is the value Excel matches on, and refusing
          // to match on it would fail every fee row in the workbook.
          // Only the sum range -- the quantity being verified -- is
          // computed rather than read.
          if (!criterionMatches(crits[k].match, critGrids[k].grid[dr][dc])) { all = false; break; }
        }
        if (!all) continue;
        var sv = resolvedGridValue(sheet, sumGrid, dr, dc, depth, visiting);
        if (!sv.ok) return { ok: false };
        if (typeof sv.value === 'number') total += sv.value;
      }
    }
    return { ok: true, value: total };
  }

  /* Rows of the RFC sheet that actually carry a quantity. A quantity
   * that is a formula (the fee table's SUMIFS rows) is computed from
   * the sheet's own lines; one that cannot be computed is reported
   * unverified and the row is left out, never read from its cache. */
  function loadRfc(sheet) {
    return loadRfcFull(sheet).items;
  }

  function loadRfcFull(sheet) {
    var m = sheet.range(RFC_FIRST_ROW, RFC_LAST_ROW, 1, 9);
    var fmap = sheet.formulasIn(RFC_FIRST_ROW, RFC_LAST_ROW, 8, 8);
    var out = [];
    var unverified = [];
    for (var i = 0; i < m.length; i++) {
      var task = m[i][0];
      var units = m[i][7];
      var rowNum = RFC_FIRST_ROW + i;
      var skip = false;
      if (fmap[rowNum + '|8'] !== undefined && task !== null) {
        var res = resolvedValue(sheet, rowNum, 8, 0, {});
        if (res.ok && typeof res.value === 'number') units = res.value;
        else {
          unverified.push({ task: 'TASK ' + fmt(task), payItem: String(m[i][1]), source: 'the rfc' });
          skip = true;
        }
      }
      if (skip || task === null || units === 0) continue;   // Python: A is not None and H != 0
      out.push(['TASK ' + fmt(task), String(m[i][1]), units]);
    }
    out.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return asNumber(a[2]) - asNumber(b[2]);
    });
    return { items: out, unverified: unverified };
  }

  /* Difference between the old and new SPI. Items are matched by the
   * pay item labels printed in each workbook, so the two workbooks do
   * not need the same rows or the same SPI version. */
  function getSpiDiff(oldSheet, newSheet) {
    return spiDiffFull(oldSheet, newSheet).items;
  }

  /* The SPI difference plus the items that could not be compared
   * because a quantity is a formula this checker cannot compute. An
   * unverified item is excluded from the difference entirely: comparing
   * it by its cached value is what produced false verdicts. */
  function spiDiffFull(oldSheet, newSheet) {
    var so = spiOrder(oldSheet, newSheet);
    var oldRes = quantities(oldSheet, so.oldLayout);
    var newRes = quantities(newSheet, so.newLayout);
    var oldQ = oldRes.values, newQ = newRes.values;
    var out = [];
    var unverified = [];
    so.order.forEach(function (pi) {
      for (var tnum = 1; tnum <= 10; tnum++) {
        var k = pi + '\u0000' + tnum;
        var unOld = !!oldRes.unverified[k], unNew = !!newRes.unverified[k];
        if (unOld || unNew) {
          unverified.push({
            task: 'TASK ' + tnum, payItem: pi,
            source: unOld && unNew ? 'the old and new spi' : (unOld ? 'the old spi' : 'the new spi')
          });
          continue;
        }
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
    return { items: sortByRank(out, so.rank), unverified: unverified };
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

  function unverifiedLines(unverified) {
    var lines = [];
    if (unverified.length) {
      lines.push('#### The following items could not be verified:');
      unverified.forEach(function (u) {
        lines.push('- could not verify ' + u.task + ' pay item ' + u.payItem +
                   ' (formula quantity in ' + u.source + ')');
      });
    }
    return lines;
  }

  function generateReport(rfcSheet, oldSheet, newSheet) {
    var rank = spiOrder(oldSheet, newSheet).rank;
    var rfcFull = loadRfcFull(rfcSheet);
    var agg = aggregateRfc(rfcFull.items, rank);
    var rfcDump = agg.items;
    var diffFull = spiDiffFull(oldSheet, newSheet);
    var spiDelta = diffFull.items;
    var unverified = rfcFull.unverified.concat(diffFull.unverified);
    var lines = [];

    // An unverified item is accounted for by the unverified section, so
    // it takes no part in the match: its counterpart on the other side
    // must not also be reported as missing.
    var unKeys = {};
    unverified.forEach(function (u) { unKeys[u.task + '|' + u.payItem] = true; });
    var rfcCmp = rfcDump.filter(function (it) { return !unKeys[it[0] + '|' + it[1]]; });
    var spiCmp = spiDelta.filter(function (it) { return !unKeys[it[0] + '|' + it[1]]; });

    var matched = rfcCmp.length === spiCmp.length &&
      rfcCmp.every(function (it) { return contains(spiCmp, it); });

    if (matched && !unverified.length) {
      lines.push('### Success!!');
      lines.push('#### RFC items were transferred to new SPI');
      agg.notes.forEach(function (n) { lines.push(n); });
      return { success: true, status: 'success', lines: lines, rfcItems: rfcDump, spiItems: spiDelta, unverified: [] };
    }

    if (matched) {
      // Every verifiable item transferred, but at least one quantity is
      // a formula this checker cannot compute. That is not a success:
      // the checker did not check that item.
      lines.push('### This rfc package could not be fully verified !');
      unverifiedLines(unverified).forEach(function (n) { lines.push(n); });
      agg.notes.forEach(function (n) { lines.push(n); });
      return { success: false, status: 'unverified', lines: lines, rfcItems: rfcDump, spiItems: spiDelta, unverified: unverified };
    }

    lines.push('### This rfc package is incorrect !');
    lines.push('#### The following items need attention:');
    agg.notes.forEach(function (n) { lines.push(n); });

    if (rfcCmp.length !== spiCmp.length) {
      lines.push("- number of items in rfc don't match new spi");
      if (rfcCmp.length > spiCmp.length) {
        lines.push('- rfc contains ' + (rfcCmp.length - spiCmp.length) + ' items that arent in the new spi');
      }
      if (rfcCmp.length < spiCmp.length) {
        lines.push('- spi contains ' + (spiCmp.length - rfcCmp.length) + ' items that arent in the rfc');
      }
    }

    rfcCmp.forEach(function (it) {
      if (!contains(spiCmp, it)) {
        lines.push('- rfc line item for ' + it[0] + ' pay item ' + it[1] + ', ' + fmt(it[2]) +
                   ' units does not appear in the new spi');
      }
    });

    spiCmp.forEach(function (it) {
      if (!contains(rfcCmp, it)) {
        lines.push('- spi line item for ' + it[0] + ' pay item ' + it[1] + ', ' + fmt(it[2]) +
                   ' units does not appear in the rfc');
      }
    });

    unverifiedLines(unverified).forEach(function (n) { lines.push(n); });

    return { success: false, status: 'incorrect', lines: lines, rfcItems: rfcDump, spiItems: spiDelta, unverified: unverified };
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
