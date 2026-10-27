#!/usr/bin/env python

import re

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


def _quantities(ws, layout):
    '''Read every task quantity in the table: {(label, task number): value}.'''
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
    return out


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

def load_rfc(rfc_worksheet):
    '''this takes a worksheet from RFC file and creates a list of tuples, 
    each tuple includes tsk, pi, uom, pi_price, new_val, total_price'''
    lol = []
    for row_file1 in rfc_worksheet.iter_rows(min_row=12, max_row=111, min_col=0,max_col=9, values_only=True):
        if (row_file1[0] != None) and (row_file1[7] !=0):
            tsk, pi, desc,_,_, uom, pi_price, new_val, total_price = row_file1
            lol.append(('TASK '+str(tsk), pi, new_val))
            lol.sort()
    return lol

def get_spi_diff(old_spi_sow, new_spi_sow):
    """takes the old SP sowunits_worksheet and the new one and checks what the difference of the new minus the old, then resulting information
    should match the items requested in the rfc. Items are matched by the
    pay item labels printed in each workbook, so the two workbooks do not
    need the same rows or the same SPI version."""
    old_layout, new_layout, order = _spi_order(old_spi_sow, new_spi_sow)
    rank = {l: i for i, l in enumerate(order)}
    old_q = _quantities(old_spi_sow, old_layout)
    new_q = _quantities(new_spi_sow, new_layout)
    lol = []
    for pi in order:
        for tnum in range(1, 11):
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
    return lol

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

def generate_report(ws_rfc, ws_old_spi, ws_new_spi):
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
    rfc_dump, rfc_notes = aggregate_rfc(load_rfc(ws_rfc), rank)
    spi_delta = get_spi_diff(ws_old_spi, ws_new_spi)
    print("rfc items: ",  rfc_dump)
    print("difference between old and new spis: ", spi_delta) 
    if rfc_dump == spi_delta:
        success = True
        st.balloons()
        report.append('### Success!!')
        report.append('#### RFC items were transferred to new SPI')
        report.extend(rfc_notes)
        print('rfc items successfully transfered to new SPI')
    else:
        success = False
        print('this rfc package is incorrect\nthe following items need attention:')
        report.append('### This rfc package is incorrect !')
        report.append('#### The following items need attention:')
        report.extend(rfc_notes)
        if len(rfc_dump) != len(spi_delta): 
            report.append('- number of items in rfc don\'t match new spi')
            print('- number of items in rfc don\'t match new spi')
            if len(rfc_dump) > len(spi_delta):
                report.append('- rfc contains {} items '
                      'that arent in the new spi'.format(len(rfc_dump)-len(spi_delta)))
                print('- rfc contains {} items '
                      'that arent in the new spi'.format(len(rfc_dump)-len(spi_delta)))
            if len(rfc_dump) < len(spi_delta):
                report.append('- spi contains {} items '
                      'that arent in the rfc'.format(len(spi_delta)-len(rfc_dump)))
                print('- spi contains {} items '
                      'that arent in the rfc'.format(len(spi_delta)-len(rfc_dump)))

        for tuple_rfc_dump in rfc_dump:
            if tuple_rfc_dump not in spi_delta:
                taskrfc, pirfc, unitsrfc = tuple_rfc_dump
                report.append('- rfc line item for {} pay item {},'
                      ' {} units does not appear in the '
                      'new spi'.format(taskrfc, pirfc, unitsrfc))
                print('- rfc line item for {} pay item {},'
                      ' {} units does not appear in the '
                      'new spi'.format(taskrfc, pirfc, unitsrfc))

        for tuple_spi_delta in spi_delta:
            if tuple_spi_delta not in rfc_dump:
                taskspi, pispi, unitsspi = tuple_spi_delta
                report.append('- spi line item for {} pay item {}, {} '
                      'units does not appear in the rfc'.format(taskspi, pispi, unitsspi))
                print('- spi line item for {} pay item {}, {} '
                      'units does not appear in the rfc'.format(taskspi, pispi, unitsspi))

    
    return report, success

st.write('# PRP Change Order Package Checker')
st.write('''### This tool makes sure all items \
in the Change Order were successfully transferred to the new SPI''')
col1, col2, col3 = st.columns(3)
with col1:
    st.write('### Step 1.')
    rfc = st.file_uploader("Upload your Excel RFC here",type='xlsm')
    if rfc != None:
        wb_rfc = openpyxl.load_workbook(rfc, read_only=True, data_only=True)
        ws_rfc = wb_rfc['RFC']
with col2:
    st.write('### Step 2.')
    old_spi = st.file_uploader("Upload Old SPI",type='xlsm')
    if old_spi != None:
        wb_old_spi = openpyxl.load_workbook(old_spi, read_only=True, data_only=True)
        ws_old_spi = wb_old_spi['SOW Units']
with col3:
    st.write('### Step 3.')
    new_spi = st.file_uploader("Upload newly generated SPI",type='xlsm')
    if new_spi != None:
        wb_new_spi = openpyxl.load_workbook(new_spi, read_only=True, data_only=True)
        ws_new_spi = wb_new_spi['SOW Units']

try:
    report, success = generate_report(ws_rfc, ws_old_spi, ws_new_spi)
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





