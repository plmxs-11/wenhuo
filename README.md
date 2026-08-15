# 文火工具箱 · wenhuo.top

一组纯前端在线工具。所有处理都在浏览器本地完成，文件不上传服务器——因此不需要后端、不需要数据库、不产生服务器费用。

线上地址：https://wenhuo.top

## 目录结构

```
wenhuo-site/
├── index.html          工具箱首页
├── word2pdf/index.html Word 转 PDF
├── merge/index.html    合并 PDF
├── split/index.html    拆分 PDF（提取页 / 删页 / 拆单页 / 按份拆）
├── compress/index.html 压缩扫描件 PDF（先检测文字层，非扫描件明确劝退）
├── verify/index.html   教用户用 F12 亲手验证「文件没上传」，内置实时请求计数器
├── pdf2jpg/index.html  PDF 转图片
├── jpg2pdf/index.html  图片转 PDF
├── rotate/index.html   旋转 PDF
├── bincard/index.html  银行卡信息查询（发卡行 / 卡种 / Luhn 校验）
├── ip/index.html       IP 归属地查询
├── assets/
│   ├── common.css      共用外壳样式
│   ├── common.js       共用工具函数（W.*）
│   ├── batch.js        批量类工具共用：文件解析 / 表格渲染 / 导出（Batch.*）
│   ├── bincard.js      BIN 号段匹配与 Luhn 校验（BinCard.*）
│   ├── xdb.js          ip2region xdb 的浏览器端查询实现（XDB.*）
│   ├── data/
│   │   ├── bin.csv         BIN 号段库，3000+ 条
│   │   └── ip2region.xdb   IP 归属地库，55 万条网段，11.1 MB
│   └── vendor/         第三方库，见下方「依赖」
├── robots.txt          搜索引擎抓取规则
├── sitemap.xml         站点地图，新增页面记得同步加进去
├── wechat-qr.png       微信收款码
├── alipay-qr.png       支付宝收款码
├── CNAME               自定义域名，GitHub Pages 用
├── .nojekyll
└── README.md
```

每个工具是一个独立 HTML 文件，零构建、零框架。改坏一个不影响其他工具。

`word2pdf/index.html` 是自包含的（样式脚本都写在文件里），其余工具共用 `assets/` 下的样式和函数。

## 本地预览

```bash
python -m http.server 8123 -d wenhuo-site
```

打开 http://localhost:8123/

注意 `python -m http.server` **不支持 HTTP Range**，会一律回 200。IP 工具的按需加载模式在它上面测不出来（会自动退回整包下载），要测这条路径得用支持 Range 的服务器。

## 依赖

全部放在 `assets/vendor/`，同源加载，不走 CDN。

| 库 | 用途 | 用在哪 |
|---|---|---|
| mammoth 1.9.0 | 解析 .docx | word2pdf |
| html2pdf.js 0.10.2 | 截图版 PDF 导出 | word2pdf |
| pdf-lib 1.17.1 | 改写 PDF（合并/拆分/旋转/嵌图） | merge, split, jpg2pdf, rotate, compress |
| pdfjs-dist 3.11.174 | 渲染 PDF、取页数、判断有无文字层 | pdf2jpg, rotate, compress |
| jszip 3.10.1 | 多文件打包下载 | split, pdf2jpg |
| SheetJS (xlsx) 0.18.5 | 读写 Excel | bincard, ip |

**不要改回 CDN。** 之前这些库都挂在 jsDelivr 上，除了国内访问不稳，还踩了一个隐蔽的坑：
浏览器不允许用跨域 URL 构造 Worker，`pdf.worker.min.js` 指向 CDN 时 `new Worker(...)` 直接抛
SecurityError，pdf.js 捕获后静默降级成 fake worker，于是 PDF 的解析和渲染全挤在主线程上，大文件必卡。
worker 路径必须同源，见 `common.js` 的 `initPdfJs()`。

pdf.js 的 worker 还必须显式指定路径，否则渲染会静默卡住，同样见 `initPdfJs()`。

## 数据文件

这两个文件是读代码看不出来的部分，换库或更新时看这里。

### `assets/data/bin.csv` — 银行卡 BIN 号段

来自开源项目 [amosnothing/card_bin](https://github.com/amosnothing/card_bin)（MIT），3000 多条号段。
随页面下载到本地比对，按最长前缀匹配，BIN 长度 3～8 位不等。
只能查到发卡行和卡种，查不到持卡人归属地——BIN 里根本没有这个信息。

### `assets/data/ip2region.xdb` — IP 归属地

来自开源项目 [lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region)，v3 格式，仅 IPv4，
55 万条网段，11.1 MB（GitHub Pages 会 gzip，传输约 4.3 MB）。当前数据更新于 2026-08-10。

更新方式：从上游下载新的 `ip2region.xdb` 覆盖即可，格式版本必须还是 v3，`xdb.js` 开头会校验并在
版本不对时直接报错。字节布局和解析逻辑都写在 `xdb.js` 的文件头注释里。

IPv6 库有 37 MB，体积太大暂时没做。

**加载模式**（`xdb.js`）：

- `lazy` —— 用 HTTP Range 只取真正读到的那几个 4 KB 块。查 10 个 IP 约 26 个请求 / 114 KB。
  25 个 IP 以内默认走这条。
- `full` —— 整包下载，存进 Cache Storage，之后完全离线。批量查询走这条。

调用 `XDB.prepare(url, ips, onProgress)` 由它自己选，返回 `'lazy'` 或 `'full'`。
服务器不给 206、块数超标、或整包已在缓存里，都会退回 `full`。`XDB.search()` 保持同步，
所以**要查哪些 IP 必须在 prepare 之前就算出来**（去重要提到加载前面）。

改按需模式的阈值搜 `MAX_LAZY_IPS` / `MAX_LAZY_BLOCKS` / `BLOCK`。

有个坑写在 `mergeRun()` 上：xdb 会在 /16 边界把大网段切成多条，必须向两侧合并才能还原真实范围，
否则「定位精度」会被高估一档。按需模式下这条合并链可能跨很多个块（实测有 106 片的链），
所以 `prepare()` 里要用 `ensureRun()` 边走边补，不能只取命中那一格。改这块之后务必拿同一批 IP
对拍 lazy 和 full 两种模式的输出，必须逐字节一致。

## 访问统计

默认**完全没有**统计代码，站点不加载任何第三方脚本。这是刻意的：`/verify/` 那一页教用户
用 F12 验证"零外部请求"，只要页面里塞了统计脚本，那页就站不住了。

要看流量，两种做法，优先第一种：

### 首选：Cloudflare 代理（服务端统计，页面零改动）

1. 在 Cloudflare 添加站点 `wenhuo.top`（免费套餐即可），按提示把域名的 NS 改到 Cloudflare
2. DNS 里加 `CNAME  @  plmxs-11.github.io`，代理状态设为 **已代理**（橙色云朵）
3. SSL/TLS 加密模式选 **Full**，否则 GitHub Pages 会和 Cloudflare 互相跳转导致死循环
4. 之后在 Cloudflare 后台就能看到访问量、来源、路径

统计在 Cloudflare 侧完成，**页面里一行脚本都不用加**，"不发请求"的承诺分毫不受影响。

### 备选：客户端 beacon（会破坏上面那个承诺）

`common.js` 顶部有 `CF_BEACON_TOKEN`，填上 Cloudflare Web Analytics 的 token 就启用。
但启用后**必须同步改掉** `/verify/` 页面和首页里关于"不加载第三方脚本"的说法——
承诺和实现对不上，比没有统计糟糕得多。

## 变现方式

免费 + 文末署名 + 自愿去除。目前只有 word2pdf 会在导出的 PDF 末尾加一行「本文档由 wenhuo.top 免费生成」，用户点「去除文末署名」可弹出赞赏码并永久去掉（存 localStorage，纯诚实系统，不做校验）。

改署名文字搜 `SIGN_TEXT`；改样式搜 `.sign`（主样式表和打印样式表各一份，两处都要改）。

收款码换成自己的：替换根目录的 `wechat-qr.png` 和 `alipay-qr.png` 即可，各页面引用的是绝对路径 `/wechat-qr.png`。

## 部署

推到 GitHub 仓库 `plmxs-11/wenhuo` 的 main 分支根目录即可，GitHub Pages 自动部署。`CNAME` 文件必须在根目录，不能删。

## 已知限制

- **Word 转 PDF**：保留正文、标题、加粗斜体、列表、表格、图片；不保留页眉页脚、页码、分栏、文本框、艺术字。旧版 `.doc` 不支持，需先另存为 `.docx`。
- **合并 / 拆分 / 旋转**：页面级操作，内容零损失；但书签、表单域、注释可能丢失。
- **PDF 转图片**：输出是图片，文字不可复制搜索。页数多时很占内存，建议分批。
- **加密 PDF**：全部工具都无法处理设了打开密码的 PDF，需先取消密码。
- **银行卡查询**：只能查发卡行和卡种，查不到归属地。号段库不可能覆盖全部新发卡产品，查不到不代表卡号无效。
- **IP 查询**：移动、联通的 4G/5G 出口地址全国混编，归属地天然不可靠，标「粗略·存疑」的结果不能作为定位依据。
- **压缩 PDF**：原理是把每页重新渲染成 JPEG，所以只适合扫描件。有文字层的 PDF 压完文字会变成图片，
  `compress/index.html` 的 `detect()` 会抽查前 5 页并明确劝退。压完变大时不自动下载，如实告知并让用户自己决定。
- 不做 PDF 转 Word / Excel / PPT——那需要把固定版面反推成可编辑排版，浏览器端做不出能用的结果。
