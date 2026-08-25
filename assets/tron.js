/*
 * TRON 链上转账查询（TronScan 公开接口）。
 *
 * ⚠️ 这是全站唯一需要联网的模块：查询地址会发给 TronScan 的服务器。
 *    其余工具都在本地完成，改动这里前先想清楚这个区别。
 *
 * 用两套接口，各取所长（2026-08 实测）：
 *
 * ● 转账明细走 TronGrid（api.trongrid.io，官方节点接口）
 *   每页 200 条，用 meta.links.next 游标翻页，没有上限。
 *   实测币安热钱包连翻 8 页拿到 1600 条仍有下一页。
 *
 * ● 机构标签走 TronScan（apilist.tronscanapi.com）
 *   只有它有 addressTag（"Binance-Hot 1" 这类），TronGrid 不提供。
 *
 * 为什么不用 TronScan 拉明细——它的坑很深：
 *   - 分页硬截断在 200 条，start=200 起一律返回空，加不加合约过滤都一样，
 *     end_timestamp 参数虽被识别但返回 0 条，绕不过去。
 *   - total 字段不可信：同一地址不加过滤报 200、加 USDT 过滤报 10000、
 *     账户摘要报 454，三个数互相矛盾。
 *   - 每页上限 50，limit=100 会静默返回空数组（不报错）。
 *
 * API key：两套接口不带 key 都能用，key 只放宽调用频率。绝不写进代码
 * ——静态站里任何 key 都是明文。用户想用自己的就存 localStorage。
 */
(function (global) {
  'use strict';

  const GRID = 'https://api.trongrid.io/v1/accounts';
  const PAGE = 200;          // TronGrid 每页上限
  const MAX_PAGES = 50;      // 兜底：最多翻 50 页（1 万条），防止极端地址把浏览器拖死
  const KEY_LS = 'tron_api_key';

  /** 官方 USDT-TRC20 合约。用来把真 USDT 和仿冒/垃圾币区分开 */
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  /** 其余常见正经稳定币，避免把它们误判成垃圾币 */
  const KNOWN = {
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': 'USDT',
    'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8': 'USDC',
    'TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT': 'USDJ',
    'TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn': 'USDD'
  };

  const getKey = () => { try { return localStorage.getItem(KEY_LS) || ''; } catch (e) { return ''; } };
  const setKey = k => { try { k ? localStorage.setItem(KEY_LS, k) : localStorage.removeItem(KEY_LS); } catch (e) {} };

  /** TRON 主网地址：T 开头，Base58，共 34 位 */
  const isAddress = s => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(s || '').trim());

  function authHeaders() {
    const h = {};
    const k = getKey();
    if (k) h['TRON-PRO-API-KEY'] = k;
    return h;
  }

  /** 限流用独立的错误类型，好让翻页循环认出来并保住已取到的数据 */
  function RateLimited() { this.name = 'RateLimited'; }
  RateLimited.prototype = Object.create(Error.prototype);

  async function grab(url, signal) {
    const resp = await fetch(url, { headers: authHeaders(), signal });
    if (!resp.ok) {
      if (resp.status === 429) throw new RateLimited();
      throw new Error(`TronGrid 返回 HTTP ${resp.status}`);
    }
    return resp.json();
  }

  /**
   * 拉取某地址的全部 TRC20 转账，沿 meta.links.next 游标一直翻到底。
   *
   * 高活跃地址（交易所热钱包这类）可能要连翻几十页，耗时很久，
   * 所以支持 opts.signal 中断：界面上给一个「停止」按钮，
   * 中断时把已经拿到的部分返回，不是全丢。
   *
   * 返回 { list, truncated, stopped, pages }。
   */
  async function fetchTransfers(address, opts) {
    const o = opts || {};
    const out = [];
    const seen = new Set();
    let url = `${GRID}/${encodeURIComponent(address)}/transactions/trc20?limit=${PAGE}`;
    if (o.contract) url += `&contract_address=${encodeURIComponent(o.contract)}`;
    let pages = 0;
    let stopped = false;
    let rateLimited = false;

    while (url && pages < MAX_PAGES) {
      if (o.signal && o.signal.aborted) { stopped = true; break; }
      let d;
      try {
        d = await grab(url, o.signal);
      } catch (e) {
        if (e && e.name === 'AbortError') { stopped = true; break; }
        // 被限流时不要把整次查询判失败——前面几页是好的，
        // 丢掉它们等于让用户白等。停在这里，如实说明没拿全。
        if (e && e.name === 'RateLimited') {
          if (pages === 0) throw new Error('请求太频繁被限流了，等一会儿再试（或在下面填自己的 API key 提高上限）');
          rateLimited = true; break;
        }
        throw e;
      }
      pages++;
      const arr = d.data || [];
      for (const t of arr) {
        const id = t.transaction_id;
        // 同一笔交易可能含多个 Transfer 事件，用 交易号+序号 去重而不是只看交易号
        const key = id + '|' + t.block_timestamp + '|' + t.from + '|' + t.to + '|' + t.value;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
      if (o.onProgress) o.onProgress(out.length, pages);
      url = ((d.meta || {}).links || {}).next || null;
    }
    return { list: out, truncated: !!url && !stopped && !rateLimited, stopped, rateLimited, pages };
  }

  /**
   * 把 TronGrid 的原始记录整理成好用的形状。
   * TronGrid 只返回成功执行的 Transfer 事件（失败的交易不产生事件），
   * 所以不需要再判断成功与否。
   */
  function normalize(t, self) {
    const ti = t.token_info || {};
    const dec = parseInt(ti.decimals, 10);
    const d = isNaN(dec) ? 6 : dec;
    let amount;
    // value 是大整数字符串，实测有 21 位、decimals=18 的记录，直接转 Number 会丢精度
    try {
      const bi = BigInt(t.value);
      const base = BigInt(10) ** BigInt(d);
      amount = Number(bi / base) + Number(bi % base) / Number(base);
    } catch (e) {
      amount = Number(t.value) / Math.pow(10, d);
    }

    const contract = ti.address || '';
    const known = KNOWN[contract];
    const from = t.from || '';
    const to = t.to || '';
    const me = String(self || '').trim();

    return {
      txId: t.transaction_id || '',
      time: t.block_timestamp ? new Date(t.block_timestamp) : null,
      from, to,
      direction: to === me ? 'in' : (from === me ? 'out' : 'other'),
      amount,
      symbol: known || ti.symbol || '?',
      tokenName: ti.name || '',
      contract,
      isKnownToken: !!known,
      isUsdt: contract === USDT
    };
  }

  /*
   * 对手方机构识别。
   *
   * 转账列表接口里的 from_address_tag / to_address_tag 实测永远是空的
   * （200 条记录全是 {"..._tag_logo": ""}），标签只能从账户接口拿：
   *   /api/account?address=X  ->  addressTag: "Binance-Hot 1"
   * 所以识别机构必须对每个对手方地址各查一次，量大时很慢，做成手动触发。
   */
  const ACCOUNT_API = 'https://apilist.tronscanapi.com/api/account';
  const tagCache = new Map();

  async function fetchAddressTag(address) {
    if (tagCache.has(address)) return tagCache.get(address);
    const headers = {};
    const k = getKey();
    if (k) headers['TRON-PRO-API-KEY'] = k;
    let tag = '';
    try {
      const resp = await fetch(`${ACCOUNT_API}?address=${encodeURIComponent(address)}`, { headers });
      if (resp.ok) {
        const d = await resp.json();
        tag = d.addressTag || '';
      }
    } catch (e) { /* 单个地址查不到不影响整体，留空即可 */ }
    tagCache.set(address, tag);
    return tag;
  }

  /**
   * 批量识别。并发压到 4，避免把 TronScan 惹毛导致整批被限流。
   * 返回 Map<地址, 标签>，没有标签的也会记进去（空串），避免重复查。
   */
  async function tagAddresses(addresses, onProgress) {
    const list = Array.from(new Set(addresses)).filter(Boolean);
    const result = new Map();
    let done = 0;
    const CONC = 4;

    async function worker(queue) {
      for (;;) {
        const a = queue.shift();
        if (!a) return;
        result.set(a, await fetchAddressTag(a));
        done++;
        if (onProgress) onProgress(done, list.length);
      }
    }
    const queue = list.slice();
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, () => worker(queue)));
    return result;
  }

  const fmtTime = d => {
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const fmtAmount = n =>
    (n === null || isNaN(n)) ? '' :
    n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

  const shortAddr = a => (!a || a.length < 14) ? (a || '') : a.slice(0, 6) + '…' + a.slice(-6);

  global.Tron = {
    USDT, KNOWN, PAGE, MAX_PAGES,
    isAddress, fetchTransfers, normalize,
    fetchAddressTag, tagAddresses,
    fmtTime, fmtAmount, shortAddr, getKey, setKey
  };
})(window);
