/* PRP Change Order Package Checker — page wiring. */
(function () {
  'use strict';

  var files = { rfc: null, old: null, new: null };
  var runBtn = document.getElementById('run');
  var result = document.getElementById('result');
  var banner = document.getElementById('banner');
  var report = document.getElementById('report');
  var detail = document.getElementById('detail');
  var tables = document.getElementById('tables');

  function slot(slotName) { return document.getElementById('slot-' + slotName); }

  /* 1229 KB is hard to read; 1.2 MB is not. */
  function fileSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function setFile(slotName, file) {
    if (!file) return;
    files[slotName] = file;
    var el = slot(slotName);
    el.classList.add('has');
    var name = el.querySelector('.file');
    name.textContent = file.name + ' · ' + fileSize(file.size);
    name.classList.remove('hidden');
    runBtn.disabled = !(files.rfc && files.old && files.new);
    result.classList.add('hidden');
  }

  document.querySelectorAll('input[type=file]').forEach(function (input) {
    input.addEventListener('change', function () {
      setFile(input.dataset.slot, input.files[0]);
    });
  });

  ['rfc', 'old', 'new'].forEach(function (name) {
    var el = slot(name);
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.remove('over'); });
    });
    el.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(name, f);
    });
  });

  function readBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('could not read ' + file.name)); };
      r.readAsArrayBuffer(file);
    });
  }

  function show(kind, text) {
    result.classList.remove('hidden');
    banner.className = 'banner ' + kind;
    banner.textContent = text;
  }

  function render(lines) {
    var html = '';
    var inList = false;
    lines.forEach(function (line) {
      if (line.indexOf('- ') === 0) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + escapeHtml(line.slice(2)) + '</li>';
        return;
      }
      if (inList) { html += '</ul>'; inList = false; }
      if (line.indexOf('#### ') === 0) html += '<h4>' + escapeHtml(line.slice(5)) + '</h4>';
      else if (line.indexOf('### ') === 0) html += '<h3>' + escapeHtml(line.slice(4)) + '</h3>';
      else if (line.indexOf('## ') === 0) html += '<h3>' + escapeHtml(line.slice(3)) + '</h3>';
      else html += '<p>' + escapeHtml(line) + '</p>';
    });
    if (inList) html += '</ul>';
    report.innerHTML = html;
    report.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function table(title, items) {
    var rows = items.map(function (it) {
      return '<tr><td>' + escapeHtml(it[0]) + '</td><td>' + escapeHtml(it[1]) + '</td><td>' + escapeHtml(it[2]) + '</td></tr>';
    }).join('');
    return '<h4>' + escapeHtml(title) + ' (' + items.length + ')</h4>' +
      '<table><thead><tr><th>Task</th><th>Pay item</th><th>Units</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="3">none</td></tr>') + '</tbody></table>';
  }

  runBtn.addEventListener('click', function () {
    runBtn.disabled = true;
    report.classList.add('hidden');
    detail.classList.add('hidden');
    show('ok', 'Reading workbooks…');

    setTimeout(function () {
      Promise.all([readBuffer(files.rfc), readBuffer(files.old), readBuffer(files.new)])
        .then(function (bufs) {
          var res = COC.analyze(bufs[0], bufs[1], bufs[2]);
          show(res.success ? 'ok' : 'bad',
               res.success ? 'Success — the RFC items are in the new SPI.' : 'This RFC package is incorrect.');
          render(res.lines);
          tables.innerHTML = table('RFC line items', res.rfcItems) + table('New SPI vs old SPI', res.spiItems);
          detail.classList.remove('hidden');
        })
        .catch(function (err) {
          show('error', err && err.message ? err.message : String(err));
        })
        .then(function () { runBtn.disabled = false; });
    }, 20);
  });
})();
