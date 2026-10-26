/* PRP Change Order Package Checker — spreadsheet logic.
 *
 * A straight port of comparenew_spi_to_rfc.py. Keep the two in sync: the
 * Python version is what runs on Streamlit, this one runs in the browser.
 *
 * Depends on PPRXlsx (ppr-xlsx.js) for reading and PAY_ITEMS/TASKS
 * (data.js). No DOM access, so it can be tested under Node.
 */
var COC = (function () {
  'use strict';

  var RFC_SHEET = 'RFC';
  var SOW_SHEET = 'SOW Units';
  var RFC_FIRST_ROW = 12;   // openpyxl min_row=12
  var RFC_LAST_ROW = 111;   // openpyxl max_row=111
  var SOW_FIRST_ROW = 11;   // openpyxl min_row=11
  var SOW_LAST_ROW = 502;   // openpyxl max_row=502
  var SOW_FIRST_COL = 9;    // column I = TASK 1
  var SOW_LAST_COL = 18;    // column R = TASK 10

  /* Python's str() on a number: 300 -> "300", 1.5 -> "1.5". */
  function fmt(v) {
    if (v === null || v === undefined) return 'None';
    return String(v);
  }

  function asNumber(v) {
    return v === null ? 0 : v;
  }

  function payIndex(pi) {
    var i = PAY_ITEMS.indexOf(pi);
    if (i === -1) {
      throw new Error(
        'Pay item "' + pi + '" is not in the checker\'s pay item list. ' +
        'If FDEP added a new pay item, regenerate data.js (tools/gen-data.py).'
      );
    }
    return i;
  }

  /* Python sorts the tuples, then re-sorts by pay item position (stable). */
  function sortItems(items) {
    items.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return asNumber(a[2]) - asNumber(b[2]);
    });
    items.sort(function (a, b) { return payIndex(a[1]) - payIndex(b[1]); });
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
    return sortItems(out);
  }

  /* Difference between the old and new SPI, cell by cell. */
  function getSpiDiff(oldSheet, newSheet) {
    var a = oldSheet.range(SOW_FIRST_ROW, SOW_LAST_ROW, SOW_FIRST_COL, SOW_LAST_COL);
    var b = newSheet.range(SOW_FIRST_ROW, SOW_LAST_ROW, SOW_FIRST_COL, SOW_LAST_COL);
    var out = [];
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < a[i].length; j++) {
        var oldVal = asNumber(a[i][j]);
        var newVal = asNumber(b[i][j]);
        if (oldVal !== newVal) {
          out.push([TASKS[j], PAY_ITEMS[i], newVal - oldVal]);
        }
      }
    }
    return sortItems(out);
  }

  function key(item) { return item[0] + '\u0000' + item[1] + '\u0000' + fmt(item[2]); }

  function contains(list, item) {
    var k = key(item);
    for (var i = 0; i < list.length; i++) if (key(list[i]) === k) return true;
    return false;
  }

  function generateReport(rfcSheet, oldSheet, newSheet) {
    var rfcDump = loadRfc(rfcSheet);
    var spiDelta = getSpiDiff(oldSheet, newSheet);
    var lines = [];

    if (rfcDump.length === spiDelta.length && rfcDump.every(function (it) { return contains(spiDelta, it); })) {
      lines.push('### Success!!');
      lines.push('#### RFC items were transferred to new SPI');
      return { success: true, lines: lines, rfcItems: rfcDump, spiItems: spiDelta };
    }

    lines.push('### This rfc package is incorrect !');
    lines.push('#### The following items need attention:');

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
