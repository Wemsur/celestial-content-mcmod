# MC百科

Celestial Launcher 的内容源插件（id：`mcmod`）。

MC百科（mcmod.cn）的模组与整合包。中文条目、中文简介、按元素分类与官方状态筛选，正文与站外链接一并读取。目前仅提供浏览与检索：站点的下载需要人工通过验证码，所以这里不做安装，条目页提供前往本站的入口。

## 提供的内容

- 模组（`mod`）—— 读 `/modlist.html`，条目页 `/class/<id>.html`
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
