# PRP Change Order Package Checker

Checks that every line item in a PRP change order (the RFC) made it into the new
SPI, and says exactly which items are missing if they didn't.

**Use it at <https://namoran.github.io/change_order_checker/>** — the old
Streamlit version is still at
<https://change-order-checker.streamlit.app/>.

Pick the three workbooks (RFC, old SPI, new SPI) and press **Check package**.
Nothing is uploaded: the files are read by JavaScript in the browser tab, so
client workbooks never leave the machine.

## How it works

`comparenew_spi_to_rfc.py` is the original Streamlit app and remains the
reference implementation. `docs/` is a port of its logic to plain JavaScript:

| file | job |
| --- | --- |
| `docs/index.html` | the page |
| `docs/ui.js` | drag/drop, file reading, rendering |
| `docs/logic.js` | port of the Python comparison logic |
| `docs/ppr-xlsx.js` | minimal `.xlsm` reader (only the parts a tool needs) |
| `docs/fflate.js` | zip decompression, vendored |
| `docs/data.js` | pay item / task lists, generated from the Python source |

The reader is deliberately not a general spreadsheet library. SheetJS needs
about 1.5 s for three 1.3 MB workbooks; reading just the sheets, rows and
columns this tool uses takes about 40–60 ms, which is why the page feels
instant. Values come from the cached values Excel stored in the file, matching
what `openpyxl(data_only=True)` returns in the Python version.

## Tests

```sh
node tests/compare.test.mjs
```

This runs the browser code under Node against four real workbooks and compares
the report to the output captured from the Python app. It expects these files in
`tests/fixtures/` (they are not committed — they are real client workbooks):

```
5632 RFC1 VERSION 4.xlsm                              (correct package)
5632 RFC1 VERSION 4 - bad.xlsm                        (8-6. quantity wrong)
PART2-AttachmentB-SPI-138506266-SA - Copy.xlsm        (old SPI)
PART2-AttachmentB-Revision1-SPI-138506266-SA.xlsm     (new SPI)
```

`node_modules` is only needed by that test (it supplies `fflate`); the page
itself has no npm dependencies.

If FDEP adds a pay item, update `comparenew_spi_to_rfc.py` and regenerate the
browser copies of the lists:

```sh
python3 tools/gen-data.py          # rewrite docs/data.js
python3 tools/gen-data.py --check  # fail if docs/data.js is stale
```

## Deploying

GitHub Pages serves `docs/` from `main`. There is no build step — commit and
push.
