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
 *
 * 两种加载模式：
 *   full  —— 整包下载（11.1 MB，GitHub Pages 压后传输约 4.3 MB），批量查询走这条。
 *   lazy  —— 只用 HTTP Range 取真正读到的那几个 4 KB 块，几个 IP 通常几十 KB 就够。
 *            少量查询（≤ 24 个 IP）默认走这条，服务器不支持 206 时自动退回 full。
 * 两种模式共用同一套解析代码：字节都存在下面的分片表里，full 只是"一个覆盖全文件的分片"。
 */
(function (global) {
  'use strict';

  const HEADER_LEN = 256;
  const VECTOR_LEN = 256 * 256 * 8;
  const SEG_LEN = 14;
  const CACHE_NAME = 'wenhuo-ipdb-v1';

  // 按需模式的取数粒度。块取小了请求数爆炸，取大了浪费流量；4 KB 下单个 IP
  // 大约是「向量格 + 段索引 + 归属地字符串」三个块，共 12 KB 左右。
  const BLOCK = 4096;
  const MAX_LAZY_IPS = 24;     // 超过就整包下载，逐个 range 反而更慢更费
  const MAX_LAZY_BLOCKS = 96;  // 块数超标说明 IP 太分散，同样退回整包（96 块 = 384 KB）
  const CONCURRENCY = 6;

  let chunks = [];        // 已就位的字节分片，按 start 升序且互不重叠
  let dbUrl = null;
  let fileSize = 0;       // 未压缩总长度，range 响应的 Content-Range 里拿
  let fullyLoaded = false;
  let headerReady = false;
  let segStart = 0;       // 段索引起止，合并被 /16 切开的网段时要用来兜住边界
  let segEnd = 0;         // 注意是最后一条记录的起始偏移，不是尾后偏移
  const decoder = new TextDecoder('utf-8');

  const isLoaded = () => fullyLoaded;

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

  /* ---------- 分片表：把"已经拿到手的字节"统一成一种读法 ---------- */

  /** 找到覆盖 pos 的分片，没有返回 null */
  function chunkAt(pos) {
    let lo = 0, hi = chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = chunks[mid];
      if (pos < c.start) hi = mid - 1;
      else if (pos >= c.end) lo = mid + 1;
      else return c;
    }
    return null;
  }

  /** 该区间的字节是否已经在手里 */
  function has(pos, len) {
    const c = chunkAt(pos);
    return !!c && pos + len <= c.end;
  }

  /**
   * 取覆盖 [pos, pos+len) 的分片。
   *
   * 缺字节时直接抛错而不是返回零值：按需模式下所有要读的字节都该由 prepare()
   * 预取到位，读不到说明预取逻辑漏了分支，宁可报错也不要静默返回错误的归属地。
   */
  function at(pos, len) {
    const c = chunkAt(pos);
    if (!c || pos + len > c.end) {
      throw new Error('IP 数据库分片缺失（偏移 ' + pos + '），请重试');
    }
    return c;
  }

  const u32 = pos => { const c = at(pos, 4); return c.view.getUint32(pos - c.start, true) >>> 0; };
  const u16 = pos => { const c = at(pos, 2); return c.view.getUint16(pos - c.start, true); };
  const slice = (pos, len) => {
    const c = at(pos, len);
    return c.u8.subarray(pos - c.start, pos - c.start + len);
  };

  /** 收下一段字节，与相邻/重叠的分片合并，保持有序不重叠 */
  function addChunk(start, u8) {
    const end = start + u8.length;
    // 完全被已有分片包住就不用管
    const exist = chunkAt(start);
    if (exist && end <= exist.end) return;

    const keep = [];
    let s = start, parts = [{ s: start, u8 }];
    let e = end;
    for (const c of chunks) {
      if (c.end < s || c.start > e) { keep.push(c); continue; }
      parts.push({ s: c.start, u8: c.u8 });
      s = Math.min(s, c.start);
      e = Math.max(e, c.end);
    }
    const merged = new Uint8Array(e - s);
    // 后写的覆盖先写的没关系，重叠区域内容本来就一样
    for (const p of parts) merged.set(p.u8, p.s - s);
    const buf = merged.buffer;
    keep.push({ start: s, end: e, u8: merged, view: new DataView(buf) });
    keep.sort((a, b) => a.start - b.start);
    chunks = keep;
  }

  function reset() {
    chunks = []; fullyLoaded = false; headerReady = false;
    segStart = segEnd = 0; fileSize = 0;
  }

  /* ---------- 取数 ---------- */

  function RangeUnsupported() { this.name = 'RangeUnsupported'; }

  /** 取 [start, end) 字节；服务器不给 206 就抛 RangeUnsupported */
  async function fetchRange(start, end) {
    const resp = await fetch(dbUrl, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (resp.status !== 206) throw new RangeUnsupported();
    const cr = resp.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) fileSize = +m[1];
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** 把一堆 [start,end) 区间按 BLOCK 对齐、去重、合并成尽量少的请求 */
  function planBlocks(ranges) {
    const ids = new Set();
    for (const [s, e] of ranges) {
      const from = Math.floor(s / BLOCK), to = Math.floor((e - 1) / BLOCK);
      for (let b = from; b <= to; b++) ids.add(b);
    }
    const sorted = Array.from(ids).sort((a, b) => a - b);
    const out = [];
    for (const b of sorted) {
      const last = out[out.length - 1];
      if (last && b === last.to + 1) last.to = b;          // 相邻块并成一次请求
      else out.push({ from: b, to: b });
    }
    return { blocks: sorted.length, requests: out };
  }

  /** 执行取数计划，跳过已经在手里的部分 */
  async function fetchPlan(plan) {
    const jobs = plan.requests
      .map(r => {
        const s = r.from * BLOCK;
        const e = Math.min((r.to + 1) * BLOCK, fileSize || (r.to + 1) * BLOCK);
        return [s, e];
      })
      .filter(([s, e]) => !has(s, e - s));

    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      const batch = jobs.slice(i, i + CONCURRENCY);
      const got = await Promise.all(batch.map(([s, e]) => fetchRange(s, e)));
      got.forEach((u8, k) => addChunk(batch[k][0], u8));
    }
  }

  /** 确保 [pos, pos+len) 在手里，缺就按块补齐（按需模式下用） */
  async function ensure(pos, len) {
    if (has(pos, len)) return;
    await fetchPlan(planBlocks([[pos, pos + len]]));
  }

  /* ---------- 加载 ---------- */

  function readHeader() {
    const version = u16(0);
    if (version !== 3) throw new Error('IP 数据库格式版本不是 3（读到 ' + version + '），解析逻辑对不上');
    segStart = u32(8);
    segEnd = u32(12);
    headerReady = true;
  }

  /** 命中 Cache Storage 的整包就直接用，省掉一切网络往返 */
  async function fromCache(url) {
    let cache = null;
    try { cache = await caches.open(CACHE_NAME); } catch (e) { return false; }  // 隐私模式下没有 caches
    const hit = await cache.match(url);
    if (!hit) return false;
    const buf = await hit.arrayBuffer();
    adoptFull(buf);
    return true;
  }

  function adoptFull(buf) {
    const u8 = new Uint8Array(buf);
    chunks = [{ start: 0, end: u8.length, u8, view: new DataView(buf) }];
    fileSize = u8.length;
    fullyLoaded = true;
    readHeader();
  }

  /** 带进度的整包下载；命中 Cache Storage 时直接返回，不再走网络 */
  async function load(url, onProgress) {
    if (fullyLoaded) return;
    dbUrl = url;
    if (await fromCache(url)) {
      onProgress && onProgress(-1, -1);   // -1 表示走的缓存，界面据此显示"读取本地缓存"
      return;
    }

    let cache = null;
    try { cache = await caches.open(CACHE_NAME); } catch (e) { /* 隐私模式下没有 caches */ }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error('IP 数据库下载失败（HTTP ' + resp.status + '）');
    const total = +(resp.headers.get('content-length') || 0);
    let buf;

    if (resp.body && total) {
      const reader = resp.body.getReader();
      const parts = [];
      let got = 0;
      // GitHub Pages 会对 .xdb 做 gzip，此时 content-length 是压缩后的大小
      // （4.3 MB），而流里读到的是解压后的字节（11.1 MB），直接相除进度会
      // 冲到 258%。一旦读超了就说明服务器压缩过，总量不可信，改成只报已下载量。
      let totalTrusted = true;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        parts.push(r.value);
        got += r.value.length;
        if (totalTrusted && got > total) totalTrusted = false;
        onProgress && onProgress(got, totalTrusted ? total : 0);
      }
      const all = new Uint8Array(got);
      let off = 0;
      for (const c of parts) { all.set(c, off); off += c.length; }
      buf = all.buffer;
    } else {
      buf = await resp.arrayBuffer();
    }

    if (cache) {
      try { await cache.put(url, new Response(buf.slice(0))); } catch (e) { /* 超配额就算了 */ }
    }
    adoptFull(buf);
  }

  /**
   * 按需模式：只取这批 IP 真正会读到的字节。
   *
   * 分三轮，每轮的位置都要等上一轮的内容才能算出来，所以省不掉往返：
   *   1. 头部（拿 segStart/segEnd） + 各 IP 的向量索引格
   *   2. 各 IP 所属 /16 的段索引区间
   *   3. 命中记录的归属地字符串，外加 mergeRun 向两侧走时越出窗口的部分
   */
  async function prepareLazy(url, ips) {
    dbUrl = url;
    if (!headerReady) {
      await ensure(0, HEADER_LEN);
      readHeader();
    }

    // 第 1 轮：向量索引格
    const cells = [];
    for (const ip of ips) {
      const pos = HEADER_LEN + (((ip >>> 24) & 255) * 256 + ((ip >>> 16) & 255)) * 8;
      cells.push([pos, pos + 8]);
    }
    let plan = planBlocks(cells);
    if (plan.blocks > MAX_LAZY_BLOCKS) return false;
    await fetchPlan(plan);

    // 第 2 轮：段索引区间。ePtr 指向该格最后一条记录的起始偏移，不是尾后偏移，
    // 所以右边界要再加一个 SEG_LEN 才能把最后一条读全。
    const segs = [];
    for (const ip of ips) {
      const pos = HEADER_LEN + (((ip >>> 24) & 255) * 256 + ((ip >>> 16) & 255)) * 8;
      const sPtr = u32(pos), ePtr = u32(pos + 4);
      if (!ePtr) continue;                      // 该 /16 没有记录
      segs.push([sPtr, ePtr + SEG_LEN]);
    }
    if (!segs.length) return true;              // 全都查不到，也算准备好了
    plan = planBlocks(segs);
    if (plan.blocks > MAX_LAZY_BLOCKS) return false;
    await fetchPlan(plan);

    // 第 3 轮：定位命中记录，把归属地字符串和 mergeRun 要走的邻居补齐
    for (const ip of ips) {
      const p = locate(ip);
      if (p === null) continue;
      await ensure(u32(p + 10), u16(p + 8));    // 归属地字符串
      await ensureRun(p);                       // 合并碎片时会读到窗口外的邻居
    }
    return true;
  }

  /**
   * 决定用哪种模式并把数据准备好，查询前调用。
   *
   * 少量 IP 走 range 按需取，批量走整包——几百个 IP 逐个发 range 请求，
   * 请求数和总流量都会比一次性下完更差。
   * 返回 'full' 或 'lazy'，界面可以据此决定进度提示怎么写。
   */
  async function prepare(url, ipStrings, onProgress) {
    if (fullyLoaded) return 'full';

    const uniq = [];
    const seen = new Set();
    for (const s of ipStrings || []) {
      const n = ipToLong(s);
      if (n === null || seen.has(n)) continue;
      seen.add(n); uniq.push(n);
    }

    if (uniq.length && uniq.length <= MAX_LAZY_IPS) {
      if (await fromCache(url)) {               // 之前整包下过就别再抠 range 了
        onProgress && onProgress(-1, -1);
        return 'full';
      }
      onProgress && onProgress(-2, -2);         // -2 表示按需读取，界面显示"只读取需要的部分"
      try {
        if (await prepareLazy(url, uniq)) return 'lazy';
        reset();                                // 块数超标，退回整包
      } catch (e) {
        // 服务器不支持 206、CDN 改写了响应、网络中途断了——都退回整包，
        // 整包路径是经过验证的老路，不能让按需模式把功能整个拖垮。
        reset();
        if (!(e instanceof RangeUnsupported) && !(e && e.name === 'TypeError')) throw e;
      }
    }

    await load(url, onProgress);
    return 'full';
  }

  /* ---------- 查询 ---------- */

  /** 二分找到命中记录的起始偏移，没有返回 null */
  function locate(ip) {
    const pos = HEADER_LEN + (((ip >>> 24) & 255) * 256 + ((ip >>> 16) & 255)) * 8;
    const sPtr = u32(pos);
    const ePtr = u32(pos + 4);
    if (!ePtr) return null;

    let lo = 0, hi = Math.floor((ePtr - sPtr) / SEG_LEN);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = sPtr + mid * SEG_LEN;
      const sip = u32(p);
      const eip = u32(p + 4);
      if (ip < sip) hi = mid - 1;
      else if (ip > eip) lo = mid + 1;
      else return p;
    }
    return null;
  }

  /** 二分查找命中的网段，返回 {raw, startIP, endIP, size}，查不到返回 null */
  function find(ipStr) {
    if (!chunks.length) throw new Error('IP 数据库还没加载');
    const ip = ipToLong(ipStr);
    if (ip === null) return null;

    const p = locate(ip);
    if (p === null) return null;
    const sip = u32(p), eip = u32(p + 4);
    const len = u16(p + 8);
    const ptr = u32(p + 10);
    const m = mergeRun(p, ptr);
    return {
      raw: decoder.decode(slice(ptr, len)),
      startIP: sip,
      endIP: eip,
      size: eip - sip + 1,
      trueStartIP: m.start,
      trueEndIP: m.end,
      trueSize: m.end - m.start + 1,
      pieces: m.pieces
    };
  }

  /* 一条碎片能不能和左边/右边的邻居合并：同一个 dataPtr 且地址首尾相连 */
  const joinLeft = p => u32(p - SEG_LEN + 10) === u32(p + 10) && u32(p - SEG_LEN + 4) + 1 === u32(p);
  const joinRight = p => u32(p + SEG_LEN + 10) === u32(p + 10) && u32(p + 4) + 1 === u32(p + SEG_LEN);

  /**
   * 还原被切开的真实网段。
   *
   * xdb 的制作工具会在 /16 边界上把跨段的记录切成多条，所以单看命中的那一条
   * 会严重低估这个归属地实际覆盖多大范围。比如移动的
   * 39.144.218.0~39.147.255.255（20 万个地址，整块写成「重庆市」）
   * 在库里被切成 4 条，每条只有 6.5 万，看起来"还行"，其实极不可靠。
   *
   * 切出来的碎片共用同一个 dataPtr 且地址首尾相连，据此向两侧合并即可还原。
   * 按需模式下这一步会读到向量格覆盖范围之外的字节，所以 prepare() 必须先用
   * ensureRun() 把整条链取全，否则这里会在分片边缘提前停下，把网段算小、
   * 进而把 precisionOf() 的判断抬高一档。
   */
  function mergeRun(p, dataPtr) {
    let L = p, R = p, pieces = 1;
    while (L - SEG_LEN >= segStart && joinLeft(L)) { L -= SEG_LEN; pieces++; }
    while (R + SEG_LEN <= segEnd && joinRight(R)) { R += SEG_LEN; pieces++; }
    return { start: u32(L), end: u32(R + 4), pieces };
  }

  /** mergeRun 的取数版：边走边补，保证同步的 mergeRun 走同样的路不会缺字节 */
  async function ensureRun(p) {
    for (let L = p; L - SEG_LEN >= segStart; ) {
      await ensure(L - SEG_LEN, SEG_LEN);
      if (!joinLeft(L)) break;
      L -= SEG_LEN;
    }
    for (let R = p; R + SEG_LEN <= segEnd; ) {
      await ensure(R + SEG_LEN, SEG_LEN);
      if (!joinRight(R)) break;
      R += SEG_LEN;
    }
  }

  const clean = v => (!v || v === '0') ? '' : v;

  /** 无符号 32 位整数 -> "1.2.3.4" */
  const longToIp = n =>
    [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

  /**
   * 用合并后的真实网段规模判断这个归属地有多可信。
   *
   * 阈值是拿真实案例标定的：同一批数据里，正确的「河北沧州」「河北石家庄」
   * 网段都在 6.5 万以内，而两条存疑的「重庆」网段分别是 20.6 万和 26.2 万。
   * 超过 6.5 万（一个 /16）基本就是把一大片地址笼统归给一个城市了。
   */
  function precisionOf(size) {
    if (size <= 1024) return { level: 'exact', text: '精确' };
    if (size <= 16384) return { level: 'good', text: '较精确' };
    if (size <= 65536) return { level: 'fair', text: '一般' };
    return { level: 'vague', text: '粗略·存疑' };
  }

  /** 返回原始字符串「国家|省份|城市|运营商|国家码」，查不到返回 null */
  function searchRaw(ipStr) {
    const hit = find(ipStr);
    return hit ? hit.raw : null;
  }

  /** 拆成结构化字段，并附带命中的网段信息 */
  function search(ipStr) {
    const hit = find(ipStr);
    if (hit === null) return null;
    const f = hit.raw.split('|');
    return {
      raw: hit.raw,
      country: clean(f[0]),
      province: clean(f[1]),
      city: clean(f[2]),
      isp: clean(f[3]),
      code: clean(f[4]),
      // 对外一律用合并后的真实网段，切开的碎片没有意义
      segment: longToIp(hit.trueStartIP) + ' ~ ' + longToIp(hit.trueEndIP),
      segmentSize: hit.trueSize,
      pieces: hit.pieces,
      precision: precisionOf(hit.trueSize)
    };
  }

  global.XDB = { load, prepare, search, searchRaw, ipToLong, longToIp, isLoaded, VECTOR_LEN, HEADER_LEN };
})(window);
