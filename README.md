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
├── pdf2jpg/index.html  PDF 转图片
├── jpg2pdf/index.html  图片转 PDF
├── rotate/index.html   旋转 PDF
├── assets/
│   ├── common.css      共用外壳样式
│   └── common.js       共用工具函数（W.*）
├── wechat-qr.png       微信收款码
├── alipay-qr.png       支付宝收款码
├── CNAME               自定义域名，GitHub Pages 用
├── .nojekyll
└── README.md
```

每个工具是一个独立 HTML 文件，零构建、零框架。改坏一个不影响其他工具。

`word2pdf/index.html` 是自包含的（样式脚本都写在文件里），其余五个工具共用 `assets/` 下的样式和函数。

## 本地预览

```bash
python -m http.server 8123 -d wenhuo-site
```

打开 http://localhost:8123/

## 部署

推到 GitHub 仓库 `plmxs-11/wenhuo` 的 main 分支根目录即可，GitHub Pages 自动部署。`CNAME` 文件必须在根目录，不能删。

## 依赖（全部走 jsDelivr CDN）

| 库 | 用途 | 用在哪 |
|---|---|---|
| mammoth 1.9.0 | 解析 .docx | word2pdf |
| html2pdf.js 0.10.2 | 截图版 PDF 导出 | word2pdf |
| pdf-lib 1.17.1 | 改写 PDF（合并/拆分/旋转/嵌图） | merge, split, jpg2pdf, rotate |
| pdfjs-dist 3.11.174 | 渲染 PDF、取页数 | pdf2jpg, rotate |
| jszip 3.10.1 | 多文件打包下载 | split, pdf2jpg |

国内访问 jsDelivr 偶尔不稳。若有用户反馈"点了没反应"，把这些 js 下载到 `assets/` 再改成相对路径即可。

注意 pdf.js 的 worker 必须显式指定路径，见 `common.js` 的 `initPdfJs()`，否则渲染会静默卡住。

## 变现方式

免费 + 文末署名 + 自愿去除。目前只有 word2pdf 会在导出的 PDF 末尾加一行「本文档由 wenhuo.top 免费生成」，用户点「去除文末署名」可弹出赞赏码并永久去掉（存 localStorage，纯诚实系统，不做校验）。

改署名文字搜 `SIGN_TEXT`；改样式搜 `.sign`（主样式表和打印样式表各一份，两处都要改）。

收款码换成自己的：替换根目录的 `wechat-qr.png` 和 `alipay-qr.png` 即可，各页面引用的是绝对路径 `/wechat-qr.png`。

## 已知限制

- **Word 转 PDF**：保留正文、标题、加粗斜体、列表、表格、图片；不保留页眉页脚、页码、分栏、文本框、艺术字。旧版 `.doc` 不支持，需先另存为 `.docx`。
- **合并 / 拆分 / 旋转**：页面级操作，内容零损失；但书签、表单域、注释可能丢失。
- **PDF 转图片**：输出是图片，文字不可复制搜索。页数多时很占内存，建议分批。
- **加密 PDF**：全部工具都无法处理设了打开密码的 PDF，需先取消密码。
- 不做 PDF 转 Word / Excel / PPT——那需要把固定版面反推成可编辑排版，浏览器端做不出能用的结果。
