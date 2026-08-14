/*
 * ip2region xdb v3 的浏览器端查询实现（仅 IPv4）。
 *
 * 字节布局（全部小端），已用 Python 逐字段对着真实库校验过：
 *   [0,256)                     头部：version(2) indexPolicy(2) createdAt(4)
 *                                     startIndexPtr(4) endIndexPtr(4) ipVersion(2) runtimePtrBytes(2)
 *   [256, 256+256*256*8)        向量索引：按 IP 前两段定位，每格 8 字节 = startPtr(4) + endPtr(4)
 *   ...                         数据区：UTF-8 的「国家|省份|城市|运营商|国家码」，0 表示未知
 *   [startIndexPtr, endIndexPtr] 段索引：每条 14 字节 = startIP(4) endIP(4) dataLen(2) dataPtr(4)
 *
 * 查询 = 用前两段查向量索引拿到范围，再在该范围内对 14 字节定长条目做二分。
 */
(function (global) {
  'use strict';

  const HEADER_LEN = 256;
  const VECTOR_LEN = 256 * 256 * 8;
  const SEG_LEN = 14;
  const CACHE_NAME = 'wenhuo-ipdb-v1';

  let bytes = null;   // Uint8Array
  let view = null;    // DataView
  const decoder = new TextDecoder('utf-8');

  const isLoaded = () => bytes !== null;

  /** "1.2.3.4" -> 无符号 32 位整数；格式不对返回 null */
  function ipToLong(s) {
    const m = String(s).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) {
      const p = +m[i];
      if (p > 255) return null;
      n = (n * 256) + p;
    }
    return n >>> 0;
  }

  /** 带进度的下载；命中 Cache Storage 时直接返回，不再走网络 */
  async function load(url, onProgress) {
    if (bytes) return;

    let cache = null;
    try { cache = await caches.open(CACHE_NAME); } catch (e) { /* 隐私模式下没有 caches */ }

    let buf = null;
    if (cache) {
      const hit = await cache.match(url);
      if (hit) {
        onProgress && onProgress(-1, -1);   // -1 表示走的缓存，界面据此显示"读取本地缓存"
        buf = await hit.arrayBuffer();
      }
    }

    if (!buf) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('IP 数据库下载失败（HTTP ' + resp.status + '）');
      const total = +(resp.headers.get('content-length') || 0);

      if (resp.body && total) {
        const reader = resp.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
          got += r.value.length;
          onProgress && onProgress(got, total);
        }
        const all = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        buf = all.buffer;
      } else {
        buf = await resp.arrayBuffer();
      }

      if (cache) {
        try { await cache.put(url, new Response(buf.slice(0))); } catch (e) { /* 超配额就算了 */ }
      }
    }

    bytes = new Uint8Array(buf);
    view = new DataView(buf);

    const version = view.getUint16(0, true);
    if (version !== 3) throw new Error('IP 数据库格式版本不是 3（读到 ' + version + '），解析逻辑对不上');
  }

  /** 返回原始字符串「国家|省份|城市|运营商|国家码」，查不到返回 null */
  function searchRaw(ipStr) {
    if (!view) throw new Error('IP 数据库还没加载');
    const ip = ipToLong(ipStr);
    if (ip === null) return null;

    const pos = HEADER_LEN + (((ip >>> 24) & 255) * 256 + ((ip >>> 16) & 255)) * 8;
    const sPtr = view.getUint32(pos, true);
    const ePtr = view.getUint32(pos + 4, true);
    if (!ePtr) return null;

    let lo = 0, hi = Math.floor((ePtr - sPtr) / SEG_LEN);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = sPtr + mid * SEG_LEN;
      const sip = view.getUint32(p, true) >>> 0;
      const eip = view.getUint32(p + 4, true) >>> 0;
      if (ip < sip) hi = mid - 1;
      else if (ip > eip) lo = mid + 1;
      else {
        const len = view.getUint16(p + 8, true);
        const ptr = view.getUint32(p + 10, true);
        return decoder.decode(bytes.subarray(ptr, ptr + len));
      }
    }
    return null;
  }

  const clean = v => (!v || v === '0') ? '' : v;

  /** 拆成结构化字段 */
  function search(ipStr) {
    const raw = searchRaw(ipStr);
    if (raw === null) return null;
    const f = raw.split('|');
    return {
      raw,
      country: clean(f[0]),
      province: clean(f[1]),
      city: clean(f[2]),
      isp: clean(f[3]),
      code: clean(f[4])
    };
  }

  global.XDB = { load, search, searchRaw, ipToLong, isLoaded, VECTOR_LEN, HEADER_LEN };
})(window);
