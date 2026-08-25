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
  /**
   * 状态行。图标由状态类推导，不写在消息里——
   * 消息常常拼接了用户的文件名，用 innerHTML 会有注入风险，
   * 所以文字一律走 textContent，图标单独 append。
   */
  function statusOf(el) {
    const ICON = { 's-ok': 'circle-check', 's-err': 'alert-triangle', 's-run': 'refresh' };
    return (msg, cls) => {
      el.className = 'status ' + (cls || '');
      el.textContent = '';
      if (!msg) return;
      const name = ICON[cls];
      if (name) {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'i');
        const use = document.createElementNS(NS, 'use');
        use.setAttribute('href', '/assets/icons.svg#' + name);
        svg.appendChild(use);
        el.appendChild(svg);
      }
      el.appendChild(document.createTextNode(msg));
    };
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

  /*
   * 访问统计（默认关闭）。
   *
   * 这个站的立身之本是「不发请求」，/verify/ 那一页就是靠这一点立信的——
   * 加任何第三方统计脚本，都会在每个页面多出一个外部请求，那页就变成半真半假。
   *
   * 首选方案是把域名接到 Cloudflare 代理，在服务端出统计，页面里一行脚本都不用加，
   * 承诺不受任何影响。做法见 README 的「访问统计」一节。
   *
   * 实在要用客户端统计，把 CF_BEACON_TOKEN 填上就会启用。但一旦启用：
   *   1. 必须去改 /verify/ 页面的说法，如实写明本站加载了哪个第三方脚本；
   *   2. 首页「零第三方脚本」之类的表述也要一并改掉。
   * 承诺和实现对不上，比没有统计糟糕得多。
   */
  const CF_BEACON_TOKEN = '';

  function mountAnalytics() {
    if (!CF_BEACON_TOKEN) return;
    const s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: CF_BEACON_TOKEN }));
    document.head.appendChild(s);
  }

  /** 页面底部的赞赏区和页脚，六个工具共用，避免每个文件抄一遍 */
  function mountFooter(wrapEl) {
    mountAnalytics();
    const box = document.createElement('div');
    box.className = 'card tip-jar';
    box.innerHTML =
      '<h3>觉得好用，请作者喝杯奶茶</h3>' +
      '<p>所有工具免费，赞赏全凭自愿</p>' +
      '<div class="qr">' +
      '<figure><img src="/wechat-qr.png" alt="微信赞赏码" onerror="this.style.opacity=.25"><figcaption>微信</figcaption></figure>' +
      '<figure><img src="/alipay-qr.png" alt="支付宝收款码" onerror="this.style.opacity=.25"><figcaption>支付宝</figcaption></figure>' +
      '</div>';
    // 这里原来印着「所有处理均在本地浏览器完成，我们看不到也拿不到你的文件」。
    // 它由 JS 生成、出现在全站每一页，前几轮只扫 HTML 所以一直没清掉。
    const ft = document.createElement('footer');
    ft.innerHTML = '<a href="/">文火工具箱</a> · wenhuo.top';
    wrapEl.appendChild(box);
    wrapEl.appendChild(ft);
  }

  /**
   * 滚动揭示。给 .rv 元素在进入视口时加 .in。
   * 用 IntersectionObserver 而不是监听 scroll——后者每帧都触发，
   * 在低端机上直接掉帧。只触发一次，看过就不再管。
   */
  function initReveal(root) {
    const els = (root || document).querySelectorAll('.rv');
    if (!els.length) return;
    if (!('IntersectionObserver' in window) ||
        matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach(el => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
    els.forEach(el => io.observe(el));
  }

  /* 导航里的主入口。改这里全站同步。 */
  const NAV_LINKS = [
    { href: '/pdf/',     name: 'PDF 工具',    match: /^\/(pdf|word2pdf|merge|split|compress|pdf2jpg|jpg2pdf|rotate)\// },
    { href: '/bincard/', name: '银行卡查询',  match: /^\/bincard\// },
    { href: '/ip/',      name: 'IP 归属地',   match: /^\/ip\// },
    { href: '/tron/',    name: 'USDT 交易',   match: /^\/tron\// }
  ];

  /**
   * 在页面最顶部挂一条吸顶导航。
   * 品牌名兼作返回首页的入口，所以不再单独放「返回工具箱」那一条，
   * 否则两条横栏叠着占地方还重复。
   */
  function mountNav() {
    if (document.querySelector('.nav')) return;
    const path = location.pathname;
    const nav = document.createElement('nav');
    nav.className = 'nav';

    const links = NAV_LINKS.map(l =>
      `<a href="${l.href}"${l.match.test(path) ? ' class="on"' : ''}>${l.name}</a>`
    ).join('');

    nav.innerHTML =
      '<div class="nav-in">' +
        '<a class="brand" href="/">' +
          '<svg class="i"><use href="/assets/icons.svg#shield-check"></use></svg>文火工具箱' +
        '</a>' +
        '<div class="links">' + links + '</div>' +
      '</div>';
    document.body.insertBefore(nav, document.body.firstChild);
  }

  /* PDF 工具清单。顺序即下拉框里的顺序，改这里全站同步。 */
  const PDF_TOOLS = [
    { slug: 'word2pdf', name: 'Word 转 PDF' },
    { slug: 'merge',    name: '合并 PDF' },
    { slug: 'split',    name: '拆分 PDF' },
    { slug: 'compress', name: '压缩扫描件 PDF' },
    { slug: 'pdf2jpg',  name: 'PDF 转图片' },
    { slug: 'jpg2pdf',  name: '图片转 PDF' },
    { slug: 'rotate',   name: '旋转 PDF' }
  ];

  /**
   * 在页头挂一个 PDF 操作切换器。
   * 七个工具原本是七个独立入口，用户想换个操作得先退回首页。
   * 用原生 select 而不是自绘下拉：手机上会调起系统选择器，
   * 键盘和读屏也都直接可用，自绘的那种反而更难用。
   */
  function mountPdfSwitch(currentSlug) {
    const host = document.querySelector('.nav .links') || document.querySelector('.topbar');
    if (!host) return;
    const box = document.createElement('div');
    box.className = 'pdfsw';
    const label = document.createElement('span');
    label.textContent = 'PDF 操作';
    const sel = document.createElement('select');
    PDF_TOOLS.forEach(t => {
      const o = document.createElement('option');
      o.value = '/' + t.slug + '/';
      o.textContent = t.name;
      if (t.slug === currentSlug) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { location.href = sel.value; });
    box.appendChild(label);
    box.appendChild(sel);
    host.appendChild(box);
  }

  global.W = { $, $$, fmtSize, download, setupDrop, statusOf, parsePages, initPdfJs,
               renderToCanvas, baseName, mountFooter, initReveal, mountNav, mountPdfSwitch, PDF_TOOLS };
})(window);
