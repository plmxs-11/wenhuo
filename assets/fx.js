/*
 * 页面效果：卡片 3D 倾斜、数字滚动。
 * 视差不在这里，那个用纯 CSS 的滚动时间线做，见 index.html。
 *
 * 两条硬约束：
 * 1. 不监听 scroll / mousemove 直接改样式——那是每帧都跑的回调，
 *    低端机直接掉帧。倾斜走 pointermove + rAF 合帧，数字滚动走
 *    IntersectionObserver 触发一次。
 * 2. 全部遵守 prefers-reduced-motion，关掉后直接给终态，不是不显示。
 */
(function (global) {
  'use strict';

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ============ 卡片 3D 倾斜 ============ */

  /**
   * 鼠标在卡片上移动时，卡片朝光标方向轻微倾斜，并跟一束高光。
   * 角度刻意压得很小（最大 6 度），大了就变成廉价的"3D 特效"。
   */
  function initTilt(selector, opts) {
    if (reduced()) return;
    // 触屏设备没有 hover，装了反而会因为 pointermove 触发误倾斜
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const max = (opts && opts.max) || 6;
    document.querySelectorAll(selector).forEach(el => {
      let raf = 0, px = 0, py = 0;

      const apply = () => {
        raf = 0;
        const r = el.getBoundingClientRect();
        const x = (px - r.left) / r.width;    // 0~1
        const y = (py - r.top) / r.height;
        el.style.setProperty('--ry', ((x - .5) * 2 * max).toFixed(2) + 'deg');
        el.style.setProperty('--rx', ((.5 - y) * 2 * max).toFixed(2) + 'deg');
        el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      };

      el.addEventListener('pointermove', e => {
        px = e.clientX; py = e.clientY;
        if (!raf) raf = requestAnimationFrame(apply);   // 合帧，一帧最多算一次
      });
      el.addEventListener('pointerenter', () => el.classList.add('tilting'));
      el.addEventListener('pointerleave', () => {
        el.classList.remove('tilting');
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* ============ 数字滚动 ============ */

  /** 1234567 -> "1,234,567"，小数位按原样保留 */
  function fmt(n, decimals) {
    return n.toLocaleString('zh-CN', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals
    });
  }

  /**
   * 让 [data-count] 元素在进入视口时从 0 数到目标值。
   * 用 easeOutExpo：开头快、结尾缓，比线性有"停下来"的手感。
   */
  function initCountUp(selector) {
    const els = document.querySelectorAll(selector || '[data-count]');
    if (!els.length) return;

    const run = el => {
      const target = parseFloat(el.dataset.count);
      if (isNaN(target)) return;
      const decimals = (el.dataset.count.split('.')[1] || '').length;
      if (reduced()) { el.textContent = fmt(target, decimals); return; }

      const dur = Math.min(1600, 600 + Math.log10(Math.max(target, 1)) * 260);
      const t0 = performance.now();
      const step = now => {
        const p = Math.min(1, (now - t0) / dur);
        const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
        el.textContent = fmt(target * eased, decimals);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (!('IntersectionObserver' in window)) { els.forEach(run); return; }
    const io = new IntersectionObserver(list => {
      list.forEach(e => {
        if (e.isIntersecting) { run(e.target); io.unobserve(e.target); }
      });
    }, { threshold: .4 });
    els.forEach(el => {
      // 先占好位，避免从 0 开始导致布局宽度跳动
      el.style.display = 'inline-block';
      el.style.minWidth = el.textContent.length + 'ch';
      el.textContent = '0';
      io.observe(el);
    });
  }

  global.FX = { initTilt, initCountUp };
})(window);
