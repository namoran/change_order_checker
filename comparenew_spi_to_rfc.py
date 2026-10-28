#!/usr/bin/env python

import io
import re
import zipfile
from xml.sax.saxutils import unescape as _xml_unescape

import openpyxl
import streamlit as st

tasks = ['TASK 1', 
         'TASK 2','TASK 3', 'TASK 4', 'TASK 5', 'TASK 6', 
         'TASK 7', 'TASK 8', 'TASK 9', 'TASK 10']

_LABEL_RE = re.compile(r'^\d{1,2}([-.][0-9A-Za-z]+)*\.$')
_TASK_RE = re.compile(r'TASK\s*(\d+)', re.IGNORECASE)


def spi_layout(ws):
    '''Locate the pay item table in an SOW Units worksheet from the
    workbook itself. The header row carries a 'PAY ITEM' cell and the
    'TASK n QUANT.' column headers; pay item labels run down the PAY ITEM
    column below the header, ending at the totals/version block. Returns
    (labels in workbook order, {label: row}, {task number: column}).
    Raises ValueError when the table cannot be found -- positions are
    never guessed, because a workbook from a different SPI version has
    different rows (Version 10.0, for example, has no section 22, so
    section 23 sits 31 rows above where a fixed list would look).'''
    header = None
    for row in ws.iter_rows(min_row=1, max_row=40, max_col=24):
        for cell in row:
            if isinstance(cell.value, str) and cell.value.strip().lower() == 'pay item':
                header = (cell.row, cell.column)
                break
        if header:
            break
    if not header:
        raise ValueError('no pay item table found in the SPI workbook: '
                         'no "PAY ITEM" header cell in the SOW Units sheet')
    hr, lc = header
    task_cols = {}
    for row in ws.iter_rows(min_row=max(1, hr - 1), max_row=hr + 1, max_col=24):
        for cell in row:
            if isinstance(cell.value, str):
                m = _TASK_RE.search(cell.value)
                if m:
                    task_cols[int(m.group(1))] = cell.column
    if not task_cols:
        raise ValueError('no task quantity columns found in the SPI workbook')
    labels, rows, misses, started = [], {}, 0, False
    label_rows = ws.iter_rows(min_row=hr + 1, max_row=ws.max_row,
                              min_col=lc, max_col=lc, values_only=True)
    for offset, (v,) in enumerate(label_rows):
        s = str(v).strip() if v is not None else ''
        if _LABEL_RE.match(s):
            started, misses = True, 0
            if s not in rows:
                rows[s] = hr + 1 + offset
                labels.append(s)
        elif started:
            misses += 1
            if misses >= 10:
                break
    if len(labels) < 10:
        raise ValueError('only {} pay items found in the SPI workbook'.format(len(labels)))
    return labels, rows, task_cols



# ---------------------------------------------------------------------------
# Formula quantities.
#
# A few quantity cells in these workbooks hold formulas instead of typed
# numbers -- the 1-7. handling fee in the SPI (a SUMIF over the task's
# reimbursable items) and the fee table in the RFC (a SUMIFS over the
# RFC's reimbursable lines). openpyxl with data_only=True supplies only
# the cached values Excel last saved, and a generated SPI keeps the old
# SPI's cache, so comparing caches fails correct packages and passes
# doctored ones. Instead, a formula cell's value is computed from the
# sheet's own data. Only the SUMIF/SUMIFS shapes are computed; anything
# else is reported as unverified by the callers -- a cached value is
# never substituted, because a stale or doctored cache is exactly what
# this replaces. Mirrors the formula section of docs/logic.js; keep the
# two in sync.

_EVAL_DEPTH = 4

_ROW_SCAN_RE = re.compile(r'<row\b[^>]*?(?:/>|>([\s\S]*?)</row>)')
_CELL_SCAN_RE = re.compile(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)')
_F_SCAN_RE = re.compile(r'<f\b([^>]*?)(?:/>|>([\s\S]*?)</f>)')
_REF_RE = re.compile(r'(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)')
_COLRANGE_RE = re.compile(r'(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})')


def _col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def _col_name(n):
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _shift_formula(text, dcol, drow):
    '''Shift a formula's cell references by (dcol, drow), the way Excel
    expands a shared formula from its master cell to a follower cell:
    references anchored with $ do not move. Quoted strings untouched.'''
    if not dcol and not drow:
        return text
    parts = re.split(r'("(?:[^"]|"")*")', text)

    def rep1(m):
        pre, d1, letters, d2, digits = m.groups()
        col, row = letters, digits
        if not d1:
            ci = _col_index(letters) + dcol
            if ci >= 1:
                col = _col_name(ci)
        if not d2:
            row = str(int(digits) + drow)
        return pre + d1 + col + d2 + row

    def rep2(m):
        pre, d1, c1, d2, c2 = m.groups()
        a = d1 + c1 if d1 else _col_name(_col_index(c1) + dcol)
        b = d2 + c2 if d2 else _col_name(_col_index(c2) + dcol)
        return pre + a + ':' + b

    for i in range(0, len(parts), 2):
        seg = _REF_RE.sub(rep1, parts[i])
        parts[i] = _COLRANGE_RE.sub(rep2, seg)
    return ''.join(parts)


def sheet_formula_map(data, sheet_name):
    '''{(row, col): formula text} for one sheet of a workbook, read from
    the workbook bytes. Shared formulas are expanded from their master
    cell; a follower whose master cannot be found maps to '' (it holds
    a formula, but not one that can be reconstructed, so callers must
    not fall back to its cached value).'''
    z = zipfile.ZipFile(io.BytesIO(data))
    wb_xml = z.read('xl/workbook.xml').decode('utf-8')
    rel_xml = z.read('xl/_rels/workbook.xml.rels').decode('utf-8')
    targets = {}
    for tag in re.findall(r'<Relationship\b[^>]*>', rel_xml):
        rid = re.search(r'Id="([^"]+)"', tag)
        tgt = re.search(r'Target="([^"]+)"', tag)
        if rid and tgt:
            targets[rid.group(1)] = tgt.group(1)
    path = None
    for tag in re.findall(r'<sheet\b[^>]*>', wb_xml):
        name = re.search(r'name="([^"]*)"', tag)
        rid = re.search(r'r:id="([^"]+)"', tag)
        if name and rid and _xml_unescape(name.group(1)) == sheet_name:
            t = targets[rid.group(1)].lstrip('/')
            path = t if t.startswith('xl/') else 'xl/' + t
            break
    if path is None:
        raise ValueError('no "{}" sheet in workbook'.format(sheet_name))
    xml = z.read(path).decode('utf-8')
    cells, masters = {}, {}
    for row_m in _ROW_SCAN_RE.finditer(xml):
        body = row_m.group(1)
        if not body:
            continue
        for cell_m in _CELL_SCAN_RE.finditer(body):
            inner = cell_m.group(2)
            if not inner:
                continue
            f = _F_SCAN_RE.search(inner)
            if not f:
                continue
            ref = re.search(r'r="([A-Z]+)(\d+)"', cell_m.group(1))
            if not ref:
                continue
            row, col = int(ref.group(2)), _col_index(ref.group(1))
            si = re.search(r'si="(\d+)"', f.group(1))
            text = _xml_unescape(f.group(2)) if f.group(2) else None
            if text:
                cells[(row, col)] = text
                if si:
                    masters[si.group(1)] = (text, row, col)
            elif si:
                cells[(row, col)] = ('si', si.group(1))
    out = {}
    for (row, col), v in cells.items():
        if isinstance(v, tuple):
            master = masters.get(v[1])
            out[(row, col)] = (_shift_formula(master[0], col - master[2], row - master[1])
                               if master else '')
        else:
            out[(row, col)] = v
    return out


class _SheetView:
    '''Values (from the data_only worksheet) plus formulas (from
    sheet_formula_map) for one sheet, with values loaded in one pass.'''

    def __init__(self, ws, fmap):
        self.ws = ws
        self.fmap = fmap or {}
        self._vals = None

    @property
    def max_row(self):
        return self.ws.max_row

    def value(self, row, col):
        if self._vals is None:
            self._vals = {}
            for cells in self.ws.iter_rows(min_row=1, max_row=self.ws.max_row,
                                           min_col=1, max_col=self.ws.max_column):
                for cell in cells:
                    if cell.value is not None:
                        self._vals[(cell.row, cell.column)] = cell.value
        return self._vals.get((row, col))

    def formula(self, row, col):
        return self.fmap.get((row, col))


def _split_args(s):
    '''Split a formula argument list on its top-level commas.'''
    out, depth, cur, in_str = [], 0, '', False
    i = 0
    while i < len(s):
        ch = s[i]
        if in_str:
            cur += ch
            if ch == '"':
                if i + 1 < len(s) and s[i + 1] == '"':
                    cur += '"'
                    i += 1
                else:
                    in_str = False
        elif ch == '"':
            in_str = True
            cur += ch
        elif ch == '(':
            depth += 1
            cur += ch
        elif ch == ')':
            depth -= 1
            cur += ch
        elif ch == ',' and depth == 0:
            out.append(cur)
            cur = ''
        else:
            cur += ch
        i += 1
    out.append(cur)
    return [a.strip() for a in out]


_RANGE_RE = re.compile(r'^\$?([A-Z]{1,3})\$?(\d+)?(?::\$?([A-Z]{1,3})\$?(\d+)?)?$')


def _parse_range(s):
    '''A1-style range: 'I11:I500', '$E$11:$E$500', a full column 'H:H',
    or a single cell. r2 is inf for a full column; callers cap it at the
    sheet's last row.'''
    m = _RANGE_RE.match(re.sub(r'\s+', '', s).upper())
    if not m:
        return None
    g1, g2, g3, g4 = m.groups()
    if g3 and bool(g2) != bool(g4):
        return None
    c1 = _col_index(g1)
    r1 = int(g2) if g2 else 1
    c2 = _col_index(g3) if g3 else c1
    r2 = int(g4) if g4 else (float('inf') if g3 else r1)
    return (c1, r1, c2, r2)


def _criterion(raw):
    '''Excel criterion to a matcher tuple, or None when unsupported.
    Text criteria match case-insensitively with * and ? wildcards (~
    escapes them); comparison criteria ('>=5') are not supported.'''
    raw = raw.strip()
    if len(raw) >= 2 and raw.startswith('"') and raw.endswith('"'):
        s = raw[1:-1].replace('""', '"')
        if s[:1] in ('<', '>', '='):
            return None
        pat, i = '', 0
        while i < len(s):
            ch = s[i]
            if ch == '~' and i + 1 < len(s) and s[i + 1] in '*?~':
                pat += re.escape(s[i + 1])
                i += 2
            elif ch == '*':
                pat += '.*'
                i += 1
            elif ch == '?':
                pat += '.'
                i += 1
            else:
                pat += re.escape(ch)
                i += 1
        return ('text', re.compile('^' + pat + '$', re.IGNORECASE))
    if re.fullmatch(r'-?\d+(\.\d+)?', raw):
        return ('num', float(raw))
    return None


def _matches(crit, value):
    kind, arg = crit
    if kind == 'num':
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value == arg
    return isinstance(value, str) and arg.match(value) is not None


def _resolved(view, row, col, depth, visiting):
    '''The value of a cell: a plain value as stored, a formula computed.
    Returns (ok, value); ok is False when a formula cannot be computed.'''
    f = view.formula(row, col)
    if f is None:
        return (True, view.value(row, col))
    if depth >= _EVAL_DEPTH or (row, col) in visiting:
        return (False, None)
    visiting.add((row, col))
    r = _eval_formula(view, f, depth + 1, visiting)
    visiting.discard((row, col))
    return r


def _eval_formula(view, text, depth, visiting):
    '''Compute a SUMIF/SUMIFS formula from the sheet's own cells,
    following Excel's semantics for the parts these workbooks use:
    criteria ranges and the sum range must cover the same extent, a
    text criterion matches case-insensitively with wildcards, and only
    numeric values in the sum range are added.'''
    m = re.match(r'^\s*(SUMIFS?)\s*\(([\s\S]*)\)\s*$', text, re.IGNORECASE)
    if not m:
        return (False, None)
    args = _split_args(m.group(2))
    if m.group(1).upper() == 'SUMIFS':
        if len(args) < 3 or len(args) % 2 == 0:
            return (False, None)
        sum_arg, pair_args = args[0], args[1:]
    else:
        if len(args) < 2 or len(args) > 3:
            return (False, None)
        pair_args = [args[0], args[1]]
        sum_arg = args[2] if len(args) == 3 else args[0]
    sum_range = _parse_range(sum_arg)
    if sum_range is None:
        return (False, None)
    crits = []
    for i in range(0, len(pair_args), 2):
        cr, cm = _parse_range(pair_args[i]), _criterion(pair_args[i + 1])
        if cr is None or cm is None:
            return (False, None)
        crits.append((cr, cm))
    max_r = view.max_row

    def cap(r):
        return (r[0], r[1], r[2], min(r[3], max_r))

    base = cap(crits[0][0])
    rows, cols = base[3] - base[1] + 1, base[2] - base[0] + 1
    if rows <= 0 or cols <= 0:
        return (False, None)
    sr = cap(sum_range)
    if sr[1] == sr[3] and sr[0] == sr[2] and (rows > 1 or cols > 1):
        # SUMIF with a single-cell sum range: Excel expands it to the
        # criteria range's extent from that corner.
        sr = (sr[0], sr[1], sr[0] + cols - 1, sr[1] + rows - 1)
    if sr[3] - sr[1] + 1 != rows or sr[2] - sr[0] + 1 != cols:
        return (False, None)
    crit_ranges = []
    for cr, _cm in crits:
        crg = cap(cr)
        if crg[3] - crg[1] + 1 != rows or crg[2] - crg[0] + 1 != cols:
            return (False, None)
        crit_ranges.append(crg)
    total = 0
    for dr in range(rows):
        for dc in range(cols):
            for (crg, cm) in zip(crit_ranges, [c[1] for c in crits]):
                # Criteria are matched on the stored value. A criteria
                # cell can hold an unrelated display formula (the RFC
                # sheet's header cells pull facility data with IF
                # formulas); what a criterion needs is the value Excel
                # matches on. Only the sum range -- the quantity being
                # verified -- is computed rather than read.
                if not _matches(cm, view.value(crg[1] + dr, crg[0] + dc)):
                    break
            else:
                ok, sv = _resolved(view, sr[1] + dr, sr[0] + dc, depth, visiting)
                if not ok:
                    return (False, None)
                if isinstance(sv, (int, float)) and not isinstance(sv, bool):
                    total += sv
                continue
            continue
    return (True, total)


def _quantities(ws, layout, view=None):
    '''Read every task quantity in the table: {(label, task number):
    value}, plus the keys whose quantity is a formula this checker
    cannot compute. A formula cell's value is its computed value, never
    its cached value (see the formula section above).'''
    labels, rows, task_cols = layout
    inv = {c: t for t, c in task_cols.items()}
    lo, hi = min(task_cols.values()), max(task_cols.values())
    first, last = min(rows.values()), max(rows.values())
    by_row = {r: l for l, r in rows.items()}
    out = {}
    grid = ws.iter_rows(min_row=first, max_row=last, min_col=lo, max_col=hi,
                        values_only=True)
    for offset, row in enumerate(grid):
        label = by_row.get(first + offset)
        if label is None:
            continue
        for j, v in enumerate(row):
            t = inv.get(lo + j)
            if t is not None and v is not None:
                out[(label, t)] = v
    unverified = set()
    if view is not None:
        for (r, c) in list(view.fmap):
            if not (first <= r <= last and lo <= c <= hi):
                continue
            label, t = by_row.get(r), inv.get(c)
            if label is None or t is None:
                continue
            ok, v = _resolved(view, r, c, 0, set())
            if ok and isinstance(v, (int, float)) and not isinstance(v, bool):
                out[(label, t)] = v
            elif ok:
                out.pop((label, t), None)
            else:
                out.pop((label, t), None)
                unverified.add((label, t))
    return out, unverified


def _spi_order(old_ws, new_ws):
    '''Label order for sorting and comparing: the new SPI's workbook
    order, then any labels only the old SPI carries, in its order.'''
    old_layout = spi_layout(old_ws)
    new_layout = spi_layout(new_ws)
    order = list(new_layout[0]) + [l for l in old_layout[0] if l not in new_layout[1]]
    return old_layout, new_layout, order


def _order_key(rank, task, pi):
    '''Sort key shared by the RFC aggregate and the SPI difference so the
    two lists line up: workbook label order first, then task number.
    Items missing from the SPI rank after all workbook items.'''
    tnum = int(str(task).split()[-1])
    if rank and pi in rank:
        return (rank[pi], tnum, '')
    return (10 ** 6, tnum, pi)

def load_rfc(rfc_worksheet, view=None):
    '''this takes a worksheet from RFC file and creates a list of tuples,
    each tuple includes tsk, pi, uom, pi_price, new_val, total_price.
    A quantity that is a formula (the fee table's SUMIFS rows) is
    computed from the sheet's own lines; one that cannot be computed is
    reported unverified and the row is left out, never read from its
    cache. Returns (items, unverified).'''
    lol = []
    unverified = []
    rows = rfc_worksheet.iter_rows(min_row=12, max_row=111, min_col=0, max_col=9,
                                   values_only=True)
    for offset, row_file1 in enumerate(rows):
        row_num = 12 + offset
        if view is not None and row_file1[0] is not None and (row_num, 8) in view.fmap:
            ok, v = _resolved(view, row_num, 8, 0, set())
            if ok and isinstance(v, (int, float)) and not isinstance(v, bool):
                row_file1 = row_file1[:7] + (v,) + row_file1[8:]
            elif ok:
                row_file1 = row_file1[:7] + (0,) + row_file1[8:]
            else:
                unverified.append(('TASK ' + str(row_file1[0]), row_file1[1], 'the rfc'))
                continue
        if (row_file1[0] != None) and (row_file1[7] !=0):
            tsk, pi, desc,_,_, uom, pi_price, new_val, total_price = row_file1
            lol.append(('TASK '+str(tsk), pi, new_val))
            lol.sort()
    return lol, unverified

def get_spi_diff(old_spi_sow, new_spi_sow):
    items, _unverified = _spi_diff_full(old_spi_sow, new_spi_sow)
    return items


def _spi_diff_full(old_spi_sow, new_spi_sow, old_view=None, new_view=None):
    """takes the old SP sowunits_worksheet and the new one and checks what the difference of the new minus the old, then resulting information
    should match the items requested in the rfc. Items are matched by the
    pay item labels printed in each workbook, so the two workbooks do not
    need the same rows or the same SPI version. Also returns the items
    that could not be compared because a quantity is a formula this
    checker cannot compute; an unverified item is excluded from the
    difference entirely, because comparing it by its cached value is
    what produced false verdicts."""
    old_layout, new_layout, order = _spi_order(old_spi_sow, new_spi_sow)
    rank = {l: i for i, l in enumerate(order)}
    old_q, old_un = _quantities(old_spi_sow, old_layout, old_view)
    new_q, new_un = _quantities(new_spi_sow, new_layout, new_view)
    unverified = []
    lol = []
    for pi in order:
        for tnum in range(1, 11):
            un_old, un_new = (pi, tnum) in old_un, (pi, tnum) in new_un
            if un_old or un_new:
                unverified.append(('TASK ' + str(tnum), pi,
                                   'the old and new spi' if un_old and un_new
                                   else 'the old spi' if un_old else 'the new spi'))
                continue
            old_val = old_q.get((pi, tnum), 0)
            new_val = new_q.get((pi, tnum), 0)
            if old_val != new_val:
                # Round the difference to 6 decimal places, the same
                # normalization aggregate_rfc applies to the RFC side.
                # The raw subtraction is a binary float: 5923.6 - 7000
                # comes out as -1076.3999999999996, which never equals the
                # RFC's -1076.4 under exact comparison and falsely rejects
                # a valid package. A difference that rounds to zero at
                # 6 decimals is float noise between two stored values of
                # the same quantity, so it is omitted, mirroring how
                # aggregate_rfc drops net-zero totals.
                delta = round(new_val - old_val, 6)
                if delta == int(delta):
                    delta = int(delta)
                if delta != 0:
                    lol.append(('TASK ' + str(tnum), pi, delta))
    lol.sort(key=lambda e: _order_key(rank, e[0], e[1]))
    return lol, unverified

def aggregate_rfc(rfc_dump, rank=None):
    '''An RFC can list the same pay item more than once in a task -- for
    example a negative line removing a placeholder amount and a positive
    line entering the actual quoted amount. FDEP's consistency rule is on
    the net effect (the new SPI total equals the previous total plus the
    RFC total), so combine lines for the same task and pay item into one
    total before comparing to the SPI difference. Returns the combined
    list plus a note for each item whose lines were combined.'''
    totals = {}
    counts = {}
    for task, pi, units in rfc_dump:
        key = (task, pi)
        totals[key] = totals.get(key, 0) + units
        counts[key] = counts.get(key, 0) + 1
    agg = []
    notes = []
    for task, pi in sorted(totals, key=lambda k: _order_key(rank, k[0], k[1])):
        units = round(totals[(task, pi)], 6)
        if units == int(units):
            units = int(units)
        if counts[(task, pi)] > 1:
            notes.append('- note: {} rfc lines for {} pay item {} were '
                         'combined into one total of {} units'.format(
                             counts[(task, pi)], task, pi, units))
        if units != 0:
            agg.append((task, pi, units))
    agg.sort(key=lambda e: _order_key(rank, e[0], e[1]))
    return agg, notes

def _unverified_lines(unverified):
    lines = []
    if unverified:
        lines.append('#### The following items could not be verified:')
        for task, pi, source in unverified:
            lines.append('- could not verify {} pay item {} '
                         '(formula quantity in {})'.format(task, pi, source))
    return lines


def generate_report(ws_rfc, ws_old_spi, ws_new_spi, formula_maps=None):
    report = []
    try:
        _, _, order = _spi_order(ws_old_spi, ws_new_spi)
    except ValueError as e:
        # The workbook's pay item table could not be located. Report that
        # plainly instead of guessing positions and risking a wrong verdict.
        report.append('### Could not read the SPI workbooks')
        report.append('- {}'.format(e))
        return report, False
    rank = {l: i for i, l in enumerate(order)}
    if formula_maps is not None:
        rfc_view = _SheetView(ws_rfc, formula_maps.get('rfc'))
        old_view = _SheetView(ws_old_spi, formula_maps.get('old'))
        new_view = _SheetView(ws_new_spi, formula_maps.get('new'))
    else:
        rfc_view = old_view = new_view = None
    rfc_items, rfc_un = load_rfc(ws_rfc, rfc_view)
    rfc_dump, rfc_notes = aggregate_rfc(rfc_items, rank)
    spi_delta, spi_un = _spi_diff_full(ws_old_spi, ws_new_spi, old_view, new_view)
    unverified = rfc_un + spi_un
    # An unverified item is accounted for by the unverified section, so
    # it takes no part in the match: its counterpart on the other side
    # must not also be reported as missing.
    un_keys = {(t, pi) for t, pi, _s in unverified}
    rfc_cmp = [it for it in rfc_dump if (it[0], it[1]) not in un_keys]
    spi_cmp = [it for it in spi_delta if (it[0], it[1]) not in un_keys]
    print("rfc items: ",  rfc_dump)
    print("difference between old and new spis: ", spi_delta)
    if rfc_cmp == spi_cmp and not unverified:
        success = True
        st.balloons()
        report.append('### Success!!')
        report.append('#### RFC items were transferred to new SPI')
        report.extend(rfc_notes)
        print('rfc items successfully transfered to new SPI')
    elif rfc_cmp == spi_cmp:
        # Every verifiable item transferred, but at least one quantity
        # is a formula this checker cannot compute. That is not a
        # success: the checker did not check that item.
        success = False
        report.append('### This rfc package could not be fully verified !')
        report.extend(_unverified_lines(unverified))
        report.extend(rfc_notes)
        print('rfc package could not be fully verified')
    else:
        success = False
        print('this rfc package is incorrect\nthe following items need attention:')
        report.append('### This rfc package is incorrect !')
        report.append('#### The following items need attention:')
        report.extend(rfc_notes)
        if len(rfc_cmp) != len(spi_cmp):
            report.append('- number of items in rfc don\'t match new spi')
            print('- number of items in rfc don\'t match new spi')
            if len(rfc_cmp) > len(spi_cmp):
                report.append('- rfc contains {} items '
                      'that arent in the new spi'.format(len(rfc_cmp)-len(spi_cmp)))
                print('- rfc contains {} items '
                      'that arent in the new spi'.format(len(rfc_cmp)-len(spi_cmp)))
            if len(rfc_cmp) < len(spi_cmp):
                report.append('- spi contains {} items '
                      'that arent in the rfc'.format(len(spi_cmp)-len(rfc_cmp)))
                print('- spi contains {} items '
                      'that arent in the rfc'.format(len(spi_cmp)-len(rfc_cmp)))

        for tuple_rfc_dump in rfc_cmp:
            if tuple_rfc_dump not in spi_cmp:
                taskrfc, pirfc, unitsrfc = tuple_rfc_dump
                report.append('- rfc line item for {} pay item {},'
                      ' {} units does not appear in the '
                      'new spi'.format(taskrfc, pirfc, unitsrfc))
                print('- rfc line item for {} pay item {},'
                      ' {} units does not appear in the '
                      'new spi'.format(taskrfc, pirfc, unitsrfc))

        for tuple_spi_delta in spi_cmp:
            if tuple_spi_delta not in rfc_cmp:
                taskspi, pispi, unitsspi = tuple_spi_delta
                report.append('- spi line item for {} pay item {}, {} '
                      'units does not appear in the rfc'.format(taskspi, pispi, unitsspi))
                print('- spi line item for {} pay item {}, {} '
                      'units does not appear in the rfc'.format(taskspi, pispi, unitsspi))

        report.extend(_unverified_lines(unverified))

    return report, success

st.write('# PRP Change Order Package Checker')
st.write('''### This tool makes sure all items \
in the Change Order were successfully transferred to the new SPI''')
col1, col2, col3 = st.columns(3)
rfc_data = old_spi_data = new_spi_data = None
with col1:
    st.write('### Step 1.')
    rfc = st.file_uploader("Upload your Excel RFC here",type='xlsm')
    if rfc != None:
        rfc_data = rfc.getvalue()
        wb_rfc = openpyxl.load_workbook(io.BytesIO(rfc_data), read_only=True, data_only=True)
        ws_rfc = wb_rfc['RFC']
with col2:
    st.write('### Step 2.')
    old_spi = st.file_uploader("Upload Old SPI",type='xlsm')
    if old_spi != None:
        old_spi_data = old_spi.getvalue()
        wb_old_spi = openpyxl.load_workbook(io.BytesIO(old_spi_data), read_only=True, data_only=True)
        ws_old_spi = wb_old_spi['SOW Units']
with col3:
    st.write('### Step 3.')
    new_spi = st.file_uploader("Upload newly generated SPI",type='xlsm')
    if new_spi != None:
        new_spi_data = new_spi.getvalue()
        wb_new_spi = openpyxl.load_workbook(io.BytesIO(new_spi_data), read_only=True, data_only=True)
        ws_new_spi = wb_new_spi['SOW Units']

try:
    formula_maps = None
    if rfc_data is not None and old_spi_data is not None and new_spi_data is not None:
        formula_maps = {'rfc': sheet_formula_map(rfc_data, 'RFC'),
                        'old': sheet_formula_map(old_spi_data, 'SOW Units'),
                        'new': sheet_formula_map(new_spi_data, 'SOW Units')}
    report, success = generate_report(ws_rfc, ws_old_spi, ws_new_spi,
                                      formula_maps=formula_maps)
    wb_rfc.close()    
    wb_old_spi.close()
    wb_new_spi.close()
    report = '  \n'.join(report)
    if success == True:
        st.image('https://www.nicepng.com/png/full/362-3624869_success-image-png.png',width=100,)
    else:
        st.image('https://purepng.com/public/uploads/large/purepng.com-sign-stoptraffic-signsign-stopnotify-driversstop-signs-1701527614263a3116.png',width=100)

    st.write(report)
    
except:
    st.write('Upload your files to process')
finally:
    st.caption('''This tool is authored by Nicholas Moran PG at [Moran.Rocks](https://Moran.Rocks)''')





