#!/usr/bin/env python3
"""Regenerate docs/data.js from comparenew_spi_to_rfc.py.

docs/data.js holds the FDEP pay item and task lists. The browser tool uses them
to turn a worksheet row/column into a label like "TASK 3 / 8-6.". They are
generated from the Python app rather than typed out, so the two can never
disagree: when FDEP adds a pay item, edit the Python file and run this.

    python3 tools/gen-data.py           # rewrite docs/data.js
    python3 tools/gen-data.py --check   # exit 1 if docs/data.js is stale
"""
import ast
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "comparenew_spi_to_rfc.py"
TARGET = ROOT / "docs" / "data.js"

# The checker reads SOW Units rows 11..502 and columns I..R.
SOW_ROWS = 492
SOW_TASKS = 10


def top_level_list(tree, name):
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id == name):
            return ast.literal_eval(node.value)
    raise SystemExit("could not find a top-level `%s = [...]` in %s" % (name, SOURCE.name))


def build():
    tree = ast.parse(SOURCE.read_text())
    pay_items = top_level_list(tree, "pay_items")
    tasks = top_level_list(tree, "tasks")

    if len(pay_items) < SOW_ROWS:
        raise SystemExit("pay_items has %d entries; the SOW sheet needs %d"
                         % (len(pay_items), SOW_ROWS))
    if len(tasks) != SOW_TASKS:
        raise SystemExit("expected %d tasks in %s, found %d"
                         % (SOW_TASKS, SOURCE.name, len(tasks)))

    def literal(values):
        return json.dumps(values, indent=0).replace("\n", " ")

    return (
        "// Generated from ../../%s — do not edit by hand.\n"
        "// Regenerate with: python3 tools/gen-data.py\n"
        "var PAY_ITEMS = %s;\n"
        "var TASKS = %s;\n"
        % (SOURCE.name, literal(pay_items), literal(tasks))
    )


def main():
    text = build()
    if "--check" in sys.argv[1:]:
        if not TARGET.exists() or TARGET.read_text() != text:
            print("docs/data.js is out of date - run: python3 tools/gen-data.py",
                  file=sys.stderr)
            return 1
        print("docs/data.js matches %s" % SOURCE.name)
        return 0

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text)
    print("wrote %s (%d bytes)" % (TARGET.relative_to(ROOT), len(text)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
