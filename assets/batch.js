/*
 * 批量查询类工具共用：文件解析 / 表格渲染 / 导出。
 * 依赖 SheetJS（xlsx.full.min.js），只有导出和读 Excel 时才用到。
 */
(function (global) {
  'use strict';

  /*
   * 内容识别器。
   *
   * 早期版本是把文件里每一列每一格都当成查询条目，结果上传一个
   * 「卡号 | 归属地 | 行号」三列的表，表头、地址、行号全被当成卡号去查，
   * 5 张卡的文件能读出 18 个条目。改成按内容特征挑，不合特征的直接跳过。
   *
   * 每个识别器接受一段文本，命中返回规范化后的值，不命中返回 null。
   */
  const MATCH = {
    // 银行卡号：12~19 位数字，允许中间有空格或短横线（6222 0212 3456 7890）
    card: s => {
      const d = String(s).replace(/[\s\-]/g, '');
      return /^\d{12,19}$/.test(d) ? d : null;
    },
    // IPv4：四段且每段 ≤255
    ipv4: s => {
      const t = String(s).trim();
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(t)) return null;
      return t.split('.').every(p => +p <= 255) ? t : null;
    }
  };

  // 单元格内的分隔符。「---」是原始数据里多值合并用的，单个短横线不能拆，
  // 否则会把 6222-0212-3456 这种写法的卡号切碎。
  const SPLIT_RE = /(?:-{2,})|[,\t;，、|\s]+/;

  /** 从一段文本里挑出符合识别器的值 */
  function pick(text, matcher, acc) {
    String(text == null ? '' : text).split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      // 先拿整行试一次，这样「6222 0212 3456 7890 123」不会被空格切碎
      const whole = matcher(line);
      if (whole) { acc.items.push(whole); acc.scanned++; return; }
      line.split(SPLIT_RE).forEach(tok => {
        const v = tok.trim();
        if (!v) return;
        acc.scanned++;
        const m = matcher(v);
        if (m) acc.items.push(m); else acc.skipped.push(v);
      });
    });
  }

  /**
   * 从 txt / csv / xlsx / 日志里抽出符合 matcher 的条目。
   * 返回 { items, skipped, scanned }——跳过多少、跳过了什么都要能说清楚，
   * 不能默默丢数据。
   */
  async function readEntries(file, matcher) {
    const acc = { items: [], skipped: [], scanned: 0 };
    const name = (file.name || '').toLowerCase();

    if (/\.(xlsx|xlsm|xls)$/.test(name)) {
      if (typeof XLSX === 'undefined') throw new Error('Excel 解析库还没加载好，稍等一下再试');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      wb.SheetNames.forEach(sn => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
        rows.forEach(r => r.forEach(c => {
          const v = String(c == null ? '' : c).trim();
          if (v) pick(v, matcher, acc);
        }));
      });
    } else {
      pick(await file.text(), matcher, acc);
    }
    return acc;
  }

  /** 从粘贴框里抽条目，规则同上 */
  function readPasted(text, matcher) {
    const acc = { items: [], skipped: [], scanned: 0 };
    pick(text, matcher, acc);
    return acc;
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
    // 列宽只用前 300 行估算。原先每列都遍历全表，10 万行 × 10 列 = 100 万次
    // 字符串转换，导出会卡住几十秒；列宽本来就只是观感，不值这个代价。
    const sample = Math.min(aoa.length, 301);
    ws['!cols'] = headers.map((h, i) => {
      let w = String(h).length * 2 + 4;
      for (let r = 0; r < sample; r++) {
        const c = aoa[r][i];
        const L = (c == null ? 0 : String(c).length) + 2;
        if (L > w) w = L;
      }
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

  /**
   * 分批 map，每批之间让出主线程。
   * 几万条一次性跑完会把页面冻住——按钮点不动、进度也刷不出来，
   * 用户只会以为网页崩了。
   */
  async function mapChunked(list, fn, onProgress, chunkSize) {
    const size = chunkSize || 2000;
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      out[i] = fn(list[i], i);
      if ((i + 1) % size === 0) {
        if (onProgress) onProgress(i + 1, list.length);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (onProgress) onProgress(list.length, list.length);
    return out;
  }

  /** 防抖。粘贴框每敲一个键就全量重解析，几万行时会明显卡顿 */
  function debounce(fn, wait) {
    let t = 0;
    return function () {
      clearTimeout(t);
      const args = arguments, self = this;
      t = setTimeout(() => fn.apply(self, args), wait || 150);
    };
  }

  global.Batch = {
    MATCH, readEntries, readPasted, renderTable,
    exportXlsx, exportCsv, copyTsv, stamp, mapChunked, debounce
  };
})(window);
