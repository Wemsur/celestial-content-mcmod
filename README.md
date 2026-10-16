# MC百科

Celestial Launcher 的内容源插件（id：`mcmod`）。

MC百科（mcmod.cn）的模组与整合包。中文条目、中文简介、按元素分类与官方状态筛选，正文与站外链接一并读取。

安装分两条路：

- **模组**走站点的下载页。站点的下载需要人工过验证码，所以插件不自己下文件，而是把下载页
  地址交给启动器；启动器开一个窗口加载该页，由用户在窗口里完成验证码与下载，再把下到的
  文件装进实例。插件**不绕过验证码**，只是把用户送到站点自己的页面上。
  很多模组在站点上根本没有可下载的文件（「暂未得到下载授权或正在上传中」），这时插件读一次
  下载页、发现没有任何文件就直接报错，**不开那个空窗**，并提示去详情页的「相关链接」找作者
  的发布页。
- **整合包**在站点没有下载，只有站外链接。详情页里指向 CurseForge 的那条链接会被启动器识别，
  变成跳转到 CurseForge 内容源对应项目页的**站内跳转**（前提是用户装了该源），在那里安装。
  插件只是如实把站点的链接放进 `links`，不认识对方的安装方式。

## 提供的内容

- 模组（`mod`）—— 读 `/modlist.html`，条目页 `/class/<id>.html`，下载页 `/download/<id>.html`
- 整合包（`modpack`）—— 读 `/modpack.html`，条目页 `/modpack/<id>.html`

## 站点结构要点

站点没有 API，全部靠解析服务端渲染的 HTML，几处容易踩的地方记在这里：

- **筛选是单选的**：`?category=1&category=2` 只会保留其中一个。所以侧边栏勾了多个
  选项时，插件对每个选项各发一次请求再合并去重。
- **两个板块各自有列表页**，且互相不在自己的页面里列出对方的分类；分类数据要从
  对应板块的列表页读，靠链接指向哪个列表来区分（链接是协议相对的 `//`，只能比较路径）。
- **只有模组的列表页认 `key` 关键字**；整合包列表页完全忽略它，所以整合包搜索走
  站点的搜索站 `search.mcmod.cn`——代价是那边不返回封面，也没有分类。
- **浏览量只在详情页**：列表页没有任何计数，详情页的 `总浏览` 被当作 `downloads`
  交给启动器（站点没有下载计数可用）。
- **正文图片是懒加载的**：`src` 是占位图，真图在 `data-src`，插件会替换后再交给启动器。
- **站外链接是包了一层跳转的**：`//link.mcmod.cn/target/<base64>` 解码后才是真地址。
- **下载页**（仅模组）`/download/<id>.html` 的 `.download-table` 每行是一个文件，行属性带
  `data-md5`（作为版本 id 交回 `openDownload`）、`data-filename`、`data-suffix`、
  `data-version`（可能是 `1.21.1/1.21` 这种合并范围，要拆开），加载器写在 `data-head` 的
  `download-api api-N` 里。**实际的下载请求要带验证码**（`POST /action/doDownload/`），
  所以插件只给页面地址，不代替用户下载。
- **限流按请求速率，很激进**：所有请求走同一个队列、彼此至少间隔 500ms，429 时整队冷却
  2.5 秒重试一次；页面按 URL 缓存 60 秒。**别退回 `Promise.all` 直发**。
- **图片按 Referer 防盗链**：`i.mcmod.cn` 带任何非 mcmod 的 `Referer` 一律 403。启动器侧
  给图片加了 `referrerpolicy="no-referrer"` 兜住。

## 构建

```bash
pnpm install
pnpm build      # 产出 dist/index.js
pnpm typecheck  # 类型检查
```

## 类型

`types/content-source.d.ts` 是启动器内容源接口的**副本**，权威版本在
[Celestial-Plugin-Store](https://github.com/Wemsur/Celestial-Plugin-Store) 的 `sdk/` 下。
它只提供类型，没有运行时代码——构建产物里不含任何对它引用。

## 需要访问的域名

插件通过启动器的网络代理发请求，只能访问 `manifest.json` 里声明过的域名：

- `www.mcmod.cn`
- `search.mcmod.cn`
- `i.mcmod.cn`

## 发布

打一个 `x.x.x` 或 `vx.x.x` 的 tag 并推送即可。工作流会构建、校验 tag 与
`manifest.json` 的版本一致、打包成 **`mcmod.zip`**（不带版本号）挂到 Release。

商店索引里的下载地址指向 `releases/latest/download/mcmod.zip`，所以**发布新版不需要
改商店**——启动器通过该链接所在的 Release 自动获得新版本。
