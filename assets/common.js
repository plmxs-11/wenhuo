/* 文火工具箱 · 共用工具函数 */
(function (global) {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /** 触发浏览器下载一个 Blob */
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** 把拖放区和隐藏的 file input 接起来。cb 收到 File 数组。 */
  function setupDrop(dropEl, inputEl, cb) {
    dropEl.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', e => {
      const fs = Array.from(e.target.files || []);
      if (fs.length) cb(fs);
    });
    ['dragenter', 'dragover'].forEach(t =>
      dropEl.addEventListener(t, e => { e.preventDefault(); dropEl.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t =>
      dropEl.addEventListener(t, e => { e.preventDefault(); dropEl.classList.remove('over'); }));
    dropEl.addEventListener('drop', e => {
      const fs = Array.from(e.dataTransfer.files || []);
      if (fs.length) cb(fs);
    });
  }

  /** 状态行输出器：say('文字','s-ok') */
  function statusOf(el) {
    return (msg, cls) => { el.className = 'status ' + (cls || ''); el.textContent = msg || ''; };
  }

  /**
   * 解析页码表达式 "1-3,5,8-10" -> 0 基下标数组（升序去重）。
   * 超出 total 的部分记进 invalid，由调用方决定提示还是忽略。
   */
  function parsePages(expr, total) {
    const set = new Set();
    const invalid = [];
    String(expr || '').split(/[,，、\s]+/).forEach(seg => {
      if (!seg) return;
      const m = seg.match(/^(\d+)(?:\s*[-~—]\s*(\d+))?$/);
      if (!m) { invalid.push(seg); return; }
      let a = parseInt(m[1], 10);
      let b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > total) { invalid.push(seg); return; }
      for (let i = a; i <= b; i++) set.add(i - 1);
    });
    return { pages: Array.from(set).sort((x, y) => x - y), invalid };
  }

  /**
   * pdf.js 的 worker 必须显式指定，否则渲染会卡住不报错。
   *
   * 路径必须同源。浏览器不允许用跨域 URL 构造 Worker，之前这里指向 jsDelivr，
   * `new Worker(...)` 直接抛 SecurityError，pdf.js 捕获后静默降级成 fake worker，
   * 于是整个解析和渲染都挤在主线程上，大文件必卡。改 CDN 前先确认这一点。
   */
  function initPdfJs() {
    if (global.pdfjsLib) {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdf.worker.min.js';
    }
  }

  /**
   * 把 pdf.js 的 page 渲染进一个新建的 canvas，返回该 canvas。
   *
   * intent 用 'print' 是刻意的，不要改回默认的 'display'：
   * display 模式下 pdf.js 内部靠 requestAnimationFrame 推进渲染，一旦用户把标签页
   * 切到后台，浏览器会冻结 rAF，渲染 promise 就永远不 resolve，界面卡在"正在渲染"。
   * print 模式不依赖 rAF，后台标签页里照样能跑完。
   */
  async function renderToCanvas(page, scale) {
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width);
    cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d');
    // JPG 没有透明通道，不铺白底的话透明区域会变成黑块
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    return cv;
  }

  /** 文件名去掉扩展名 */
  const baseName = name => String(name || '').replace(/\.[^.]+$/, '');

  /** 页面底部的赞赏区和页脚，六个工具共用，避免每个文件抄一遍 */
  function mountFooter(wrapEl) {
    const box = document.createElement('div');
    box.className = 'card tip-jar';
    box.innerHTML =
      '<h3>☕ 觉得好用，请作者喝杯奶茶</h3>' +
      '<p>所有工具永久免费，赞赏全凭自愿，1 块也是心意</p>' +
      '<div class="qr">' +
      '<figure><img src="/wechat-qr.png" alt="微信赞赏码" onerror="this.style.opacity=.25"><figcaption>微信</figcaption></figure>' +
      '<figure><img src="/alipay-qr.png" alt="支付宝收款码" onerror="this.style.opacity=.25"><figcaption>支付宝</figcaption></figure>' +
      '</div>';
    const ft = document.createElement('footer');
    ft.innerHTML = '所有处理均在本地浏览器完成，我们看不到也拿不到你的文件<br>' +
      '<a href="/">文火工具箱</a> · wenhuo.top';
    wrapEl.appendChild(box);
    wrapEl.appendChild(ft);
  }

  global.W = { $, $$, fmtSize, download, setupDrop, statusOf, parsePages, initPdfJs, renderToCanvas, baseName, mountFooter };
})(window);
