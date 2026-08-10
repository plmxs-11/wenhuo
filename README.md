# Word 转 PDF 在线工具

纯前端的 Word(.docx) 转 PDF 工具。文档在浏览器本地解析，不上传任何服务器，因此不需要后端、不需要数据库、不产生服务器费用。

## 目录说明

```
word2pdf-site/
├── index.html      工具本体（单文件，含全部样式和脚本）
├── wechat-qr.png   微信收款码（自己放，可选）
├── alipay-qr.png   支付宝收款码（自己放，可选）
├── .nojekyll       告诉 GitHub Pages 不要用 Jekyll 处理
└── README.md
```

`index.html` 是完全自包含的，单独拷走双击也能用。

## 本地预览

```bash
python -m http.server 8123 -d word2pdf-site
```

然后打开 http://localhost:8123/

## 部署到 GitHub Pages

1. 在 GitHub 新建一个仓库（Public），例如 `word2pdf`。
2. 把 `word2pdf-site` 目录里的文件（注意是**目录里的文件**，不是目录本身）传到仓库根目录。
3. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `main` / `/(root)`，Save。
4. 等 1~3 分钟，访问 `https://<你的用户名>.github.io/word2pdf/`。

## 文末署名

导出的 PDF 末尾会带一行淡灰小字「本文档由 wenhuo.top 免费生成」，用来做自然传播。用户点「去除文末署名」会弹出赞赏码，点「去除署名」即永久去掉（存在 localStorage，纯诚实系统，不做校验）。再点一次按钮可以恢复。

改署名文字：搜 `SIGN_TEXT`。改样式：搜 `.sign`（主样式表和打印样式表里各一份，两处都要改）。

## 放收款码

把两张收款码图片命名为 `wechat-qr.png` 和 `alipay-qr.png`，放在 `index.html` 同一目录即可，页面底部赞赏区会自动显示。没有放图时会自动淡化，不影响工具使用。

## CDN 依赖

页面依赖两个 jsDelivr 上的库：

- `mammoth@1.9.0` —— 解析 .docx
- `html2pdf.js@0.10.2` —— 生成图片版 PDF

国内访问 jsDelivr 偶尔不稳。如果有用户反馈"点了没反应"，把这两个 js 下载到本目录，再把 `index.html` 里的两行 `<script src="...">` 改成相对路径即可。

## 已知限制

会保留：标题、正文、加粗斜体、有序/无序列表、表格、图片。

不会保留：页眉页脚、页码、分栏、文本框、艺术字、复杂图表。这是浏览器端解析的技术边界。

旧版 `.doc` 不支持，需先用 Word 另存为 `.docx`。
