/*
 * 批量查询类工具共用：文件解析 / 表格渲染 / 导出。
 * 依赖 SheetJS（xlsx.full.min.js），只有导出和读 Excel 时才用到。
 */
(function (global) {
  'use strict';

  /** 从 txt / csv / xlsx 里抽出所有非空单元格，按出现顺序返回字符串数组 */
  async function readEntries(file) {
    const name = (file.name || '').toLowerCase();
    if (/\.(xlsx|xlsm|xls)$/.test(name)) {
      if (typeof XLSX === 'undefined') throw new Error('Excel 解析库还没加载好，稍等一下再试');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const out = [];
      wb.SheetNames.forEach(sn => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
        rows.forEach(r => r.forEach(c => {
          const v = String(c == null ? '' : c).trim();
          if (v) out.push(v);
        }));
      });
      return out;
    }
    // txt / csv：按行拆，再按常见分隔符拆单元格
    const text = await file.text();
    const out = [];
    text.split(/\r?\n/).forEach(line => {
      line.split(/[,\t;，、\s]+/).forEach(c => {
        const v = c.trim();
        if (v) out.push(v);
      });
    });
    return out;
  }

  /** 从粘贴框里抽条目，规则同上 */
  function readPasted(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach(line => {
      line.split(/[,\t;，、\s]+/).forEach(c => {
        const v = c.trim();
        if (v) out.push(v);
      });
    });
    return out;
  }

  /**
   * 渲染结果表格。
   * rows 里每格可以是字符串，也可以是 {v, cls} 用来给单元格加样式。
   * 超过 maxRows 只画前 maxRows 行——几千行 DOM 会把浏览器拖死，完整数据让用户导出去看。
   */
  function renderTable(wrapEl, headers, rows, maxRows) {
    const cap = maxRows || 500;
    const shown = rows.slice(0, cap);
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const th = headers.map(h => `<th>${esc(h)}</th>`).join('');
    const tb = shown.map(r => '<tr>' + r.map(c => {
      const v = (c && typeof c === 'object') ? c.v : c;
      const cls = (c && typeof c === 'object' && c.cls) ? ` class="${c.cls}"` : '';
      return `<td${cls}>${esc(v == null ? '' : v)}</td>`;
    }).join('') + '</tr>').join('');

    wrapEl.innerHTML = `<table class="res"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>` +
      (rows.length > cap
        ? `<div class="trunc">表格只显示前 ${cap} 条，共 ${rows.length} 条。完整结果请用上面的导出按钮。</div>`
        : '');
  }

  const plain = rows => rows.map(r => r.map(c => (c && typeof c === 'object') ? c.v : c));

  function exportXlsx(headers, rows, filename) {
    if (typeof XLSX === 'undefined') throw new Error('Excel 库还没加载好，稍等一下再试');
    const aoa = [headers].concat(plain(rows));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = headers.map((h, i) => {
      let w = String(h).length * 2 + 4;
      aoa.forEach(r => { const L = String(r[i] == null ? '' : r[i]).length + 2; if (L > w) w = L; });
      return { wch: Math.min(w, 42) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '查询结果');
    XLSX.writeFile(wb, filename);
  }

  function exportCsv(headers, rows, filename) {
    const q = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.map(q).join(',')].concat(plain(rows).map(r => r.map(q).join(',')));
    // 加 BOM，否则 Excel 打开中文是乱码
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    W.download(blob, filename);
  }

  async function copyTsv(headers, rows) {
    const text = [headers.join('\t')].concat(plain(rows).map(r => r.join('\t'))).join('\n');
    await navigator.clipboard.writeText(text);
    return rows.length;
  }

  const stamp = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  };

  global.Batch = { readEntries, readPasted, renderTable, exportXlsx, exportCsv, copyTsv, stamp };
})(window);
