/*
 * TRON 链上转账查询（TronScan 公开接口）。
 *
 * ⚠️ 这是全站唯一需要联网的模块：查询地址会发给 TronScan 的服务器。
 *    其余工具都在本地完成，改动这里前先想清楚这个区别。
 *
 * 实测记下来的接口怪癖（2026-08 测于真实地址）：
 *
 * 1. 不需要 API key。带 key 和不带 key 返回完全一致，key 只放宽调用频率。
 *    所以本模块默认不带 key；用户想用自己的 key 就存在 localStorage，
 *    绝不写进代码——静态站里任何 key 都是明文。
 *
 * 2. total 字段不可信。同一个地址：不加过滤报 200，加 USDT 合约过滤报 10000，
 *    账户摘要接口报 454。三个数互相矛盾。
 *
 * 3. 分页硬性截断在 200 条左右。start=200 起一律返回空，无论 total 报多少，
 *    也无论加不加合约过滤。end_timestamp 参数虽被识别但返回 0 条，绕不过去。
 *    => 高活跃地址拿不全，必须如实告诉用户，不能假装数据是完整的。
 *
 * 4. 每页上限 50。limit=100 或 200 会返回空数组（不是报错，是静默返回空）。
 */
(function (global) {
  'use strict';

  const API = 'https://apilist.tronscanapi.com/api/token_trc20/transfers';
  const PAGE = 50;          // 接口每页上限，超过会静默返回空
  const HARD_CAP = 200;     // 实测的分页天花板
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

  async function fetchPage(address, start, contract) {
    let url = `${API}?limit=${PAGE}&start=${start}&relatedAddress=${encodeURIComponent(address)}`;
    if (contract) url += `&contract_address=${encodeURIComponent(contract)}`;
    const headers = {};
    const k = getKey();
    if (k) headers['TRON-PRO-API-KEY'] = k;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      if (resp.status === 429) throw new Error('请求太频繁被 TronScan 限流了，等一会儿再试（或在下面填自己的 API key 提高上限）');
      throw new Error(`TronScan 返回 HTTP ${resp.status}`);
    }
    return resp.json();
  }

  /**
   * 拉取某地址的 TRC20 转账。
   * onProgress(已取条数) 用于显示进度。
   * 返回 { list, reachedCap, claimedTotal }——reachedCap 为真表示撞到接口天花板，
   * 数据很可能不完整，界面必须如实标出来。
   */
  async function fetchTransfers(address, opts) {
    const o = opts || {};
    const out = [];
    const seen = new Set();
    let claimedTotal = null;

    for (let start = 0; start < HARD_CAP; start += PAGE) {
      const d = await fetchPage(address, start, o.contract);
      if (claimedTotal === null) claimedTotal = d.total;
      const arr = d.token_transfers || [];
      if (!arr.length) break;
      for (const t of arr) {
        const id = t.transaction_id;
        if (id && seen.has(id)) continue;   // 接口偶尔重复给同一条
        if (id) seen.add(id);
        out.push(t);
      }
      if (o.onProgress) o.onProgress(out.length);
      if (arr.length < PAGE) break;         // 最后一页
    }
    return { list: out, reachedCap: out.length >= HARD_CAP - 1, claimedTotal };
  }

  /** 把接口返回的原始记录整理成好用的形状 */
  function normalize(t, self) {
    const ti = t.tokenInfo || {};
    const dec = parseInt(ti.tokenDecimal, 10);
    const raw = t.quant;
    let amount = null;
    // quant 是字符串大整数，位数可能超过 Number 精度，用 BigInt 稳妥
    try {
      const d = isNaN(dec) ? 6 : dec;
      const bi = BigInt(raw);
      const base = BigInt(10) ** BigInt(d);
      amount = Number(bi / base) + Number(bi % base) / Number(base);
    } catch (e) {
      amount = Number(raw) / Math.pow(10, isNaN(dec) ? 6 : dec);
    }

    const contract = t.contract_address || '';
    const known = KNOWN[contract];
    const from = t.from_address || '';
    const to = t.to_address || '';
    const me = String(self || '').trim();

    return {
      txId: t.transaction_id || '',
      time: t.block_ts ? new Date(t.block_ts) : null,
      from, to,
      direction: to === me ? 'in' : (from === me ? 'out' : 'other'),
      amount,
      symbol: known || ti.tokenAbbr || '?',
      tokenName: ti.tokenName || '',
      contract,
      isKnownToken: !!known,
      isUsdt: contract === USDT,
      success: (t.finalResult || t.contractRet) === 'SUCCESS',
      risky: !!t.riskTransaction
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
    USDT, KNOWN, HARD_CAP, PAGE,
    isAddress, fetchTransfers, normalize,
    fetchAddressTag, tagAddresses,
    fmtTime, fmtAmount, shortAddr, getKey, setKey
  };
})(window);
