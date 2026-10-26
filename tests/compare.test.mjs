/* Node test: the browser port must produce the same report as the Python app.
 *
 * Fixtures are the real PRP workbooks. Point FIXTURES at a directory holding:
 *   5632 RFC1 VERSION 4.xlsm                  (correct package)
 *   5632 RFC1 VERSION 4 - bad.xlsm            (8-6. quantity wrong)
 *   PART2-AttachmentB-SPI-138506266-SA - Copy.xlsm              (old SPI)
 *   PART2-AttachmentB-Revision1-SPI-138506266-SA.xlsm           (new SPI)
 *
 * Run: node tests/compare.test.mjs [fixtures-dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = path.resolve(process.argv[2] || 'tests/fixtures');
const F = {
  rfcGood: path.join(dir, '5632 RFC1 VERSION 4.xlsm'),
  rfcBad: path.join(dir, '5632 RFC1 VERSION 4 - bad.xlsm'),
  spiOld: path.join(dir, 'PART2-AttachmentB-SPI-138506266-SA - Copy.xlsm'),
  spiNew: path.join(dir, 'PART2-AttachmentB-Revision1-SPI-138506266-SA.xlsm'),
};

// Load the same scripts the page loads, into one sandbox.
const sandbox = { console, TextDecoder };
vm.createContext(sandbox);
const run = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
sandbox.fflate = require('fflate');
run('docs/ppr-xlsx.js');
run('docs/data.js');
run('docs/logic.js');
const COC = sandbox.COC;

const read = (p) => {
  const b = fs.readFileSync(p);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
};

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

// Expected values captured by running the Python app against these fixtures.
console.log('Comparing against comparenew_spi_to_rfc.py output:');

const good = COC.analyze(read(F.rfcGood), read(F.spiOld), read(F.spiNew));
check('good RFC succeeds', good.success, true);
check('good RFC report', good.lines, [
  '### Success!!',
  '#### RFC items were transferred to new SPI',
]);
check('good RFC item count (python: 17)', good.rfcItems.length, 17);
check('good RFC first item', good.rfcItems[0], ['TASK 3', '1-4.', 300]);
check('good RFC last item', good.rfcItems[16], ['TASK 4', '12-13.', 1]);

const bad = COC.analyze(read(F.rfcBad), read(F.spiOld), read(F.spiNew));
check('bad RFC fails', bad.success, false);
check('bad RFC report', bad.lines, [
  '### This rfc package is incorrect !',
  '#### The following items need attention:',
  '- rfc line item for TASK 3 pay item 8-6., 2 units does not appear in the new spi',
  '- spi line item for TASK 3 pay item 8-6., 1 units does not appear in the rfc',
]);

// Timing, to keep the "fast" claim honest.
const bufs = [read(F.rfcGood), read(F.spiOld), read(F.spiNew)];
const runs = 10;
const t0 = performance.now();
for (let i = 0; i < runs; i++) COC.analyze(bufs[0], bufs[1], bufs[2]);
const ms = (performance.now() - t0) / runs;
const mb = (bufs.reduce((n, b) => n + b.byteLength, 0) / 1048576).toFixed(1);
console.log(`\n  ${mb} MB of workbooks parsed and compared in ${ms.toFixed(0)} ms`);

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
