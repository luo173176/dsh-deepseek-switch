# dsh-deepseek-switch

给 **DeepSeek Harness** 桌面版加一个「Chat / Harness」双工作区切换器：同一个窗口里，一边是 `chat.deepseek.com` 官方网页（内嵌 WebView，登录态可跨重启恢复），一边是 Harness 原来的智能体工作区（会话、工作区、任务、工具全部保留）。

英文说明见 [README.en.md](README.en.md)。

---

## 1. 它解决什么

ChatGPT 桌面版可以在 ChatGPT 与 Codex 之间一键切换。Harness 之前只能二选一：要么离开工作区去开官方网页，要么留在 Harness 但拿不到官方网页体验。本插件把两者放进同一个窗口：

- 侧边栏多一行 **Chat**（就在 `新会话` 下面），点它进入官方网页工作区；按返回逻辑或 `Alt+2` 回到原工作区。
- Chat 区是**真正的官方页面**（`https://chat.deepseek.com/`），不是仿制界面：登录、发消息、上传文件、看历史都是官方功能。
- 切换只做显示/隐藏，**不重建 WebView**（4 次往返实测新增 0 个访客实例）。
- 返回 Harness 走 `layout.selectPanel(lastPanel)`，**不会新建会话**，回到你进 Chat 之前那个面板。
- 登录态写进 `~/.dsh/dsh-deepseek-switch/session.json`，重启后首次导航前写回页面存储；实测重启后仍显示「欢迎回来」。

## 2. 功能列表

| 能力 | 状态 |
|------|------|
| 侧边栏 Chat 入口 + 主面板工作区 | ✅ |
| 顶部原生标题栏与窗口控件不被覆盖 | ✅（浮层顶边取自 `.frame` 实测 `paddingTop`） |
| Chat ⇄ Harness 双向切换（含 `Alt+1` / `Alt+2`） | ✅ |
| 返回不新建会话、回到进 Chat 前的面板 | ✅ |
| 切换不重建 WebView、不重复创建窗口 | ✅ |
| 登录态跨应用重启恢复（页面 `localStorage` + 非 HttpOnly cookie） | ✅ 已在 0.2.1-rc.2 实测 |
| HttpOnly 分区 cookie（`ds_session_id`、WAF 键）搬运 | ❌ 本架构不可达，见 §7 |
| 模式记忆（重启回到上次的模式） | ✅ |
| 页面加载失败时的「重试 / 浏览器打开 / 返回 Harness」 | ✅（断网场景未实测） |
| 官方账号与 Harness 账号打通（SSO） | ❌ 官方无此接口，见 §7 |

## 3. 环境要求

- **DeepSeek Harness 桌面版 0.2.1-rc.2**：本插件只在这个版本上实测过，`package.json` 声明 `engines.dsh: ">=0.2.1-rc.2"`。
- Node.js ≥ 22（只有本地跑测试需要）。
- 已在 Windows 11 验证；其它平台未验证。

## 4. 安装

插件是一个标准 Harness **bundle**（`dsh.bundle.patch` + `dsh.client`）。装完**重启 Harness** 生效：Host 半边只在进程启动时加载。

### 方式 A：在 Harness 里让智能体装（推荐）

在 Harness 对话框里说：

```text
plugin_manager install_bundle target=github:luo173176/dsh-deepseek-switch
```

`plugin_manager` 的 `target` 接受 **npm 包名 / git URL / tarball URL / 绝对本地目录**。返回 `application: restart-required` 就重启应用。

### 方式 B：命令行

```powershell
# 用与桌面版同版本的 CLI，避免 profile 版本错配；桌面版在跑时先完全退出
npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile desktop add github:luo173176/dsh-deepseek-switch
```

`dsh plugin --profile <name>` 的语义是**在该 profile 目录里执行 pnpm**。实测（本机 0.2.1-rc.2）：装到一个新建 profile 时 bundle 会被自动选中（`dsh.profile.bundles` 出现 `dsh-deepseek-switch`）；但 **`desktop` 这个保留 profile 走的是纯 pnpm 分支，不会自动选中 bundle**，装完还需要在 Harness 里用 `plugin_manager`（`list_bundles` / `set_bundle`）或插件页面点启用。

### 方式 C：本地开发

```powershell
git clone https://github.com/luo173176/dsh-deepseek-switch.git
```

然后：

```text
plugin_manager install_bundle target=<克隆下来的绝对目录>
```

### 安装后的验证

```text
plugin_manager list_plugins     # 应出现 dsh-deepseek-switch，fiberPhase=active
plugin_manager list_bundles     # bundles 里应有 dsh-deepseek-switch
```

`%USERPROFILE%\.dsh\dsh-deepseek-switch\diag.ndjson` 里应出现一行 `{"stage":"apply","route":"/dsh-deepseek-switch/rpc",...}`。

## 5. 使用

| 操作 | 结果 |
|------|------|
| 点侧边栏 `Chat` 行 | 进入官方网页工作区 |
| `Alt+1` | 同上 |
| `Alt+2` | 回到 Harness 原工作区（进 Chat 前的那个面板） |
| 再点一次 `Chat` 行 | 回 Harness（同一行是开关） |
| Chat 右上角 ⟳ | 只重新加载官方页面（见下） |
| 侧边栏 `新会话` | Harness 原生新建会话，与本插件无关 |

### 刷新 Chat 页面

在别处（手机、另一个浏览器）新建了会话，嵌入页不会自己知道。点 Chat 右上角的 ⟳ 按钮即可重新加载官方页面：

- 调的是这个 `<webview>` 自己的 `reload()`——同一分区、同一实例、同一页面上下文，Cookie 与 `localStorage` 都留在里面，**不会退出登录**；
- 只影响 Chat，Harness 的会话、面板、正在跑的任务都不动；不会新开窗口或第二个实例；
- 加载中按钮进入禁用 + 旋转态，重复点击被忽略（`refreshing` 状态机去重）；`did-stop-loading` / `did-fail-load` / `destroyed` 任一到达才恢复；
- 刷新不清 Cookie、不清存储、不删 `session.json`；加载完成后照常写回快照（与平时一样受恢复门控约束，未登录的空白页不会覆盖旧快照）；
- 刷新只保证"页面重新拉取了官方数据"，**不保证官方服务端已经把别处的会话同步过来**——那取决于官方自身的刷新节奏，插件不宣称"已同步"。

## 6. 登录持久化怎么做的

根因（0.2.1-rc.2 实测）：Harness 主进程给内嵌浏览器发的分区名是 `dsh-sidebar-browser-<randomUUID()>`，**每次启动都变**，cookie 容器跟着换；同时 Harness 的 Host 半边跑在 `ELECTRON_RUN_AS_NODE=1` 的 Node 模式子进程里，`require('electron')` 只拿到二进制路径，读不到 `session.cookies`。

所以本插件用**用户态快照**：

1. 页面加载完成后，客户端把 `chat.deepseek.com` 的 `localStorage` 与 `document.cookie`（剔除 AWS WAF 键）交给 Host 半边；
2. Host 写进 `~/.dsh/dsh-deepseek-switch/session.json`（`.tmp` → `rename`，POSIX 下 `0600`），只保留 `deepseek.com` 域；
3. 下次启动：先建 `about:blank#<lease>` 容器 → 取回快照 → 页面首次加载后写回存储 → `reload()` 一次 → 状态机进入 `done` 才开始自动保存；
4. 恢复完成前所有自动保存被门控，**空白页不会覆盖旧快照**；快照损坏只报告、不删除。

| 内容 | 路径 |
|------|------|
| 登录快照 | `%USERPROFILE%\.dsh\dsh-deepseek-switch\session.json`（设了 `DSH_HOME` 就跟随它） |
| 模式记忆 | `%USERPROFILE%\.dsh\dsh-deepseek-switch\state.json` |
| 诊断日志 | `%USERPROFILE%\.dsh\dsh-deepseek-switch\diag.ndjson`（只有阶段与计数，**不含 cookie 值或键名**） |

安全说明：

- 快照只落在当前用户目录，不上传、不进仓库（`.gitignore` 已排除）。
- 该文件等价于浏览器登录态，请勿分享或提交；共享机器上建议用完删除。
- 插件不复制系统浏览器或其它应用的 cookie，不伪造令牌，不绕过验证码或官方风控。

**退出登录 / 清理**：在官方页面里正常退出，或删除 `session.json`（下次进 Chat 需要重新登录）。

## 7. 只注册一次（重复的 loader 条目）

**症状**：插件市场里更新别的插件时失败，报

```
@local/dsh-deepseek-switch: duplicate loader entry id "deepseek-switch" (2 rows)
重复的 loader 条目 id "deepseek-switch"（2 条记录），已自动回滚并恢复原版本文件。
```

插件列表里也会出现两个 `DeepSeek Switch`。

**根因不在套件本身的一次性 bug，而在 profile 里留了同目录的第二份注册**：

1. 早先本插件以 `@local/dsh-deepseek-switch` 的名字安装（本地目录安装默认走 `@local/<name>`），后来包名改成 `dsh-deepseek-switch`，`dependencies` 与 `dsh.profile.bundles` 里就同时存在两条，**都 `link:` 到同一个目录**；
2. 宿主组合配置时，`dsh.profile.bundles` 的**每个条目都会生成一层**（`dshmarket/src/check.ts` 的 `buildBundleLayers`），两层都展开同一份 `cordis.patch.yml`，而那张表里只有一行 `- id: deepseek-switch` ⇒ 同一个 id 被两行 loader 记录抢；
3. 运行中 `remove_bundle` 对 `@local/...` 返回 `bundle-in-use`，旧名字删不掉，于是重启也不自愈。

**修复**：Host 半边每次 `apply` 都会跑一次 `deduplicateRegistration()`（`index.js`）：

- 只在 profile 的 `dependencies` / `dsh.profile.bundles` 里找**解析到本插件目录**的条目（`realpath` 比较），保留包名权威的那一条，其余删除；
- 改前先 `copyFile` 出 `package.json.bak-<时间戳>`，再 `writeFile(.tmp) + rename` 原子落盘；
- 顺手 `rm` 掉 `node_modules/@local/dsh-deepseek-switch` 这个残留链接（`@local` 空了才删目录）；
- **只碰指向本插件目录的条目**：其它插件的 `@local/...`、正常的 npm 依赖、别人的 `bundles` 条目一律不动；
- 已干净时**不写文件**（字节级不变）⇒ 幂等，可反复跑；
- 结果写进 `diag.ndjson` 的 `{stage:"registration", changed, kept, removed, backup}`，`session-state` 也能读到。

真机记录（2026-10-21，桌面 profile）：`{"stage":"registration","changed":true,"kept":"dsh-deepseek-switch","removed":["@local/dsh-deepseek-switch"],"backup":"…package.json.bak-2026-10-21T06-31-00-563Z","error":""}`，之后手动再跑返回 `changed:false`。清理后 **`restart` 也不再生出重复**——因为重复的源头（两份注册）已经不在了，而不是靠隐藏或过滤列表。

## 8. 已知限制

1. **HttpOnly 分区 cookie 拿不到**：`ds_session_id`、`HWWAFSESID`、`HWWAFSESTIME` 在 Node 模式宿主里不可读。当前登录靠页面 `localStorage.userToken`，实测够用；若官方改版把登录态做成纯 HttpOnly，这条路线会失效。
2. **不保证所有 DSH 版本**：只实测 `0.2.1-rc.2`。Harness 若更换内嵌浏览器实现（分区规则、lease 协议），本插件需要跟着改。
3. **不做账号打通（SSO）**：Harness 的账号是它自己的平台 token（`account.origin` 注入 cookie/header），与 `chat.deepseek.com` 网页登录是两套东西，官方没有公开的共享登录接口。插件也不读取 Harness 的 token 去冒充网页登录。
4. **不保证通过官方风控**：内嵌浏览器访问官方站点时可能遇到验证码或环境校验，这是站点行为，插件不绕过。
5. **聊天历史不互通**：网页历史留在网页，Harness 会话留在 Harness，没有官方 API 合并。
6. **断网 / 页面结构变化**：提供「重试 / 浏览器打开 / 返回 Harness」，具体错误文案取决于官方页面。
7. **刷新按钮只重载页面**：它让内嵌页重新拉取官方数据，不改变官方服务端对其它设备的同步节奏；刚在别处新建的会话可能要等官方自己刷新才出现，插件不会宣称「已同步」。

## 9. 排查

| 现象 | 检查 |
|------|------|
| 侧边栏没有 `Chat` 行 | `plugin_manager list_plugins` 看 `fiberPhase`；`pending` 多为依赖没就绪或 profile 没重启 |
| 点 Chat 报 `/dsh-deepseek-switch/rpc` 404 | Host 半边没加载：看 `diag.ndjson` 有无 `apply` 行；Host 改动必须重启应用 |
| Chat 区空白 | 看 `diag.ndjson` 的 `guest-attached` 与页面 `did-fail-load`，用「重试 / 浏览器打开」兜底 |
| 重启后要重新登录 | 看 `client-boot` 的 `snapshot` 与 `session-restore` 的 `storage` 条数；为 0 说明快照没写成功或页面未登录 |
| 顶部出现重复标题 | 本插件不绘制标题栏；若出现说明另有插件叠加了浮层 |
| 别处新建的会话在 Chat 里看不到 | 点 Chat 右上角 ⟳ 重新加载；`diag.ndjson` 有 `chat-refresh` 行即已发出 |
| 更新别的插件报 `duplicate loader entry id "deepseek-switch"` | 见第 7 节：`diag.ndjson` 的 `registration` 行会写明删掉了哪一条；必要时手动跑一次 `deduplicateRegistration()` |
| 插件列表出现两个 DeepSeek Switch | 同上——列表条数来自 `dsh.profile.bundles`，去重后自然只剩一个，不靠过滤 |

## 10. 开发与测试

```powershell
npm test        # 宿主半边 16 个用例，不联网、不需要登录
npm run check   # node --check index.js / client.js
```

```text
index.js                 Host 半边：快照读写、Electron 探测、/dsh-deepseek-switch/rpc
client.js                Client 半边：浮层 WebView、侧边栏入口、主面板、模式管理
cordis.patch.yml         bundle patch：insert 本插件一行
locale/{zh,en}.json      插件标题与描述
icon.svg                 侧边栏/插件页图标
test/host.test.mjs       宿主半边测试（12 例）
```

## 11. 致谢与许可

- 登录快照的思路，以及「恢复完成前暂停自动保存」「排除 WAF 键」等细节参考了 [jaychang1989/dsh-webchat](https://github.com/jaychang1989/dsh-webchat)（Apache-2.0）0.7.8；本插件按其架构重写，未直接复制文件。
- 本项目以 MIT 许可发布，见 [LICENSE](LICENSE)。
- DeepSeek、DeepSeek Harness 是深度求索公司的产品名；本项目为第三方插件，与官方无隶属关系。
