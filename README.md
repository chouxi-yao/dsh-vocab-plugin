# 词场 Vocab · dsh-vocab-plugin

> DeepSeek Harness 单词插件：输入框旁一个数词胶囊，点开是一张居中的**碎片化复习卡片** —
> 正面只露单词，翻面给释义和例句，然后按 `1 / 2 / 3` 自评，调度层据此安排下一次到期时间。

## 安装

一键安装（从 GitHub Release 拉 tarball，pnpm 会缓存这个包）：

```bash
dsh plugin add https://github.com/chouxi-yao/dsh-vocab-plugin/releases/download/v1.0.1/dsh-vocab-plugin-1.0.1.tgz
```

装完**完全退出桌面端再打开**（宿主启动时把客户端 bundle 快照进内存，刷新页面不换包）。

更新版本时先卸载再装，同一个地址不会自动重解析：

```bash
dsh plugin remove dsh-vocab-plugin
dsh plugin add https://github.com/chouxi-yao/dsh-vocab-plugin/releases/download/v1.0.1/dsh-vocab-plugin-1.0.1.tgz
```

从源码安装（不需要构建，`dist/` 与 `data/` 已随仓库提交）：

```bash
git clone https://github.com/chouxi-yao/dsh-vocab-plugin.git
dsh plugin add ./dsh-vocab-plugin
```

## 界面

| 位置 | 形态 |
| --- | --- |
| 输入框左侧 | `📖 CET4` / `📖 CET6` 胶囊：只显示当前词库名，点击打开词卡 |
| 新会话 | `conversation.input.left` 在 sessionId 生成前不渲染，胶囊会回落到英雄区槽位 / 左下角 DOM 兜底胶囊；有任意一个可用就不会重复出现 |
| 点击胶囊 | 居中悬浮卡片（440px），背后轻微模糊的遮罩 |
| 卡片顶部 | `CET4` / `CET6` 切换标签（当前词库高亮）+ 已背张数 `已背 7` |
| 卡片正面 | 单词（大字号）+ 词性；不显示音标 |
| 点击卡片 / `空格` | 3D 翻面 → 核心释义 + 例句 |
| 翻面后底部 | `忘了 1` / `模糊 2` / `会了 3`，直接按数字键也行 |
| 队列见底 | 静默追加下一张，背不完不用管；只有两个池都空了才收尾 |
| 全背完 | 「🎉 今日词库已背完」（到期池 + NEW 池都空）+ 本词库待学/已学/收服统计 |
| 冷却中 | 「🌙 到期的词都在冷却中」+ 24h / 单日 3 次的说明 |
| 右上角 ⚙️ | 打开设置，调试工具（拨到明天 / 造到期词 / 重置）都收在这里，日常不可见 |
| `Esc` / × / 点遮罩 | 关闭卡片（`Esc` 先关设置再关卡） |

没有列表、没有搜索框、没有分页，也没有点赞/点踩。

## 调度规则（简化间隔，暂不上 FSRS）

自评时写入 `dueAt`：

| 自评 | `dueAt` | 本轮行为 |
| --- | --- | --- |
| `3` 会了 | `now + 3 天` | 直接下一张 |
| `2` 模糊 | `now + 1 天` | 直接下一张 |
| `1` 忘了 | 明天 `00:00` | **立刻插到本轮队尾重试**（受单日 3 次上限约束） |

**取词队列（无限流，没有批次上限）**：

1. 点开胶囊时，把 `dueAt <= now` 的到期词**全部**入队（按逾期最久优先），不再卡 15 张；
2. 手上剩下的卡 **< 3 张**时，客户端自动调 `POST /next` 追加，追加时带上手上已有的 key
   做排除，所以不会重复推送同一张；
3. 追加时如果到期池已经见底（< 3 个），就从 `NEW`（从未学过）池随机补 **1-3 个**；
   被抽出的新词立刻转 `LEARNING`，**不会**再出现在随机新词池里；
4. 只要池子里还有词，就能一直背下去；`/next` 只在「到期池 + NEW 池」都真的空了才返回
   `reason: "exhausted"`。

**跨天连续答对与收服（KNOWN）**：

- 每个词记录 `consecutiveCorrect`（跨天连续答对次数）和 `lastGradeDay`；
- **只有跨天复习才计数**：判定用「这次复习前，`dueAt` 的日期是否早于今天」——
  新词当天学（`dueAt` = 今天）和"忘了"后的当天重试（`dueAt` = 明天）都不算跨天；
- 跨天时：`3 会了` → +1；`2 模糊` → 不变；`1 忘了` → 清零（当天忘了同样清零）；
- `consecutiveCorrect >= 3` 且这一次是 `3 会了` → 状态置为 **`KNOWN`**，`dueAt` 推到上限，
  **永久移出复习队列**，`/queue`、`/next`、`/debug/due` 都不会再碰它；
- 左下角统计永远是向 `GET /decks` 现取的，打分和追加新卡后都会刷新：
  `待学 X · 已学 Y · 收服 Z`。

**冷却与防刷**：

- 同一个词 24 小时内最多出现 1 次（`1 忘了` 的当天重试是唯一例外）；
- 单个词一天最多出现 3 次，到顶后当天不再弹；
- 到期池和 NEW 池都真空了 → 才显示「🎉 今日词库已背完」；若只是到期词都在冷却，
  显示「🌙 到期的词都在冷却中」。

## 数据

词库**由 `原始资料/` 只读派生**，源文件永不修改：

```bash
pnpm run build:words   # 读 原始资料/3-CET4-顺序.json、4-CET6-顺序.json
```

`scripts/build-wordbooks.mjs` 的派生规则：

1. 两本书合计 7508 + 5651 行，同一 headword 会按词性重复 → 按小写词形合并去重；
2. 释义去重后以 `；` 连接，词性去重后空格连接；
3. 若 `data/deck.json`（第一轮的高质量富化卡）里有该词的音标/例句，一并带上（**音标只留在数据里，界面不展示**）；
4. 产出 `data/cet4.json`（4544 词）、`data/cet6.json`（3991 词）。

单词语料结构：`{ "id": "crown", "w": "crown", "y": "王冠，冕；花冠", "p": "n" }`。

> `data/deck.json` 是 47 张带音标/例句的富化卡，由 `pnpm run build:deck` 生成（查
> `api.dictionaryapi.dev`，结果烘进文件，运行时零网络请求）。它现在只作为
> `build:words` 的富化来源，不再直接驱动界面。

## 复习状态

落盘在 `$DSH_HOME/dsh-vocab/reviews.json`（默认 `~/.dsh/dsh-vocab/reviews.json`），
**按 `(deckId, wordId)` 独立存储**，两个词库互不影响：

```json
{
  "version": 2,
  "activeDeck": "cet4",
  "words": {
    "cet4|crown": {
      "status": "REVIEW",          // NEW | LEARNING | REVIEW
      "dueAt": 1792894785351,      // 下一次到期时间（毫秒）
      "shownAt": 1792648785351,    // 最后一次展示
      "shownDay": "2026-10-22",    // 最后一次展示的本地日期
      "shownToday": 1,             // 当天已展示次数（上限 3）
      "seen": 1,                   // 累计展示次数
      "grades": [0, 0, 1],         // 忘了/模糊/会了 累计
      "lastGrade": 3,
      "lastGradeDay": "2026-10-21", // 最后一次自评日期（跨天判定）
      "consecutiveCorrect": 2       // 跨天连续答对次数，3 次后 status 变 KNOWN
    }
  }
}
```

写入是 120ms 去抖 + 临时文件 `rename` 原子替换；插件卸载时 flush。第一轮的扁平格式
（`{last,seen,c1,c2,c3}`）会在启动时自动迁移成 `REVIEW` 且立即到期。

## HTTP 接口

前缀 `/dsh-vocab-plugin/api`（**注册时不带结尾斜杠** —— 宿主按字面匹配 prefix）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/decks` | 两个词库的 total / learned / due / fresh + 当前 active |
| `POST` | `/deck` | `{deck:"cet4"\|"cet6"}` 切换当前词库（落盘） |
| `GET` | `/queue?deck=&size=` | 取初始队列；**不带 `size` 时返回全部到期词** |
| `POST` | `/next` `{deck, exclude, want}` | 追加下一张（到期优先，见底补新词；`exclude` 排除手上已有的卡） |
| `POST` | `/seen` | `{key}` 卡片真正展示时打点（冷却 / 当日次数） |
| `POST` | `/grade` | `{key, grade:1\|2\|3}` 自评，返回 `dueAt`、`retry`、`known`、`crossDay`、`consecutiveCorrect` |
| `GET` | `/state` | 概览（含 store / data 绝对路径） |
| `GET` | `/debug/stats` | 每个词库的 new / learning / review / due / 今日已封顶数 |
| `POST` | `/debug/due` | `{deck?, count?}` 让已学词立刻到期 |
| `POST` | `/debug/learn` | `{deck?, count?}` 把 NEW 词直接标成已学且到期 |
| `POST` | `/debug/age` | `{deck?, days?=1, count?}` 把到期时间往前拨 N 天（模拟"明天再来"，验证跨天/收服） |
| `POST` | `/debug/reset` | `{deck?}` 清空该词库复习状态 |

## 怎么验证调度层是对的

**不用改系统时间。** 卡片底部有两个调试按钮（`🐞 造到期`、`♻️ 重置`），也可以直接打接口：

```bash
BASE=http://127.0.0.1:60243/dsh-vocab-plugin/api   # 换成当前 GUI 端口

# 0) 看两个词库的状态分布
curl -s $BASE/debug/stats | python3 -m json.tool

# 1) 造 5 个"已学且立刻到期"的词
curl -s -X POST $BASE/debug/learn -d '{"deck":"cet4","count":5}'

# 2) 取初始队列：source=due 全给，到期池 < 3 时才补 source=new
curl -s "$BASE/queue?deck=cet4" | python3 -m json.tool

# 3) 验证到期规则：1 → 明天且 retry；3 → +3 天
curl -s -X POST $BASE/grade -d '{"key":"cet4|crown","grade":1}'
curl -s -X POST $BASE/grade -d '{"key":"cet4|crown","grade":3}'

# 4) 验证落盘
cat ~/.dsh/dsh-vocab/reviews.json | head -40

# 5) 验证跨天收服（不用等三天）：学一个词 → 每天往前拨一天再答"会了"
curl -s -X POST $BASE/debug/age -d '{"deck":"cet4","days":1,"count":50}'
curl -s $BASE/queue?deck=cet4            # 被拨过的词重新到期
curl -s -X POST $BASE/grade -d '{"key":"cet4|crown","grade":3}'   # crossDay=true、consecutiveCorrect+1
# 连做三次 → 第 3 次返回 known=true、status=KNOWN，之后队列里再也不出现

# 6) 重置回干净状态
curl -s -X POST $BASE/debug/reset -d '{"deck":"cet4"}'
```

界面自测顺序：打开胶囊 → 连评 5 张「会了」→ 卡片不会停在「这一轮走完了」，而是继续来新卡 → 关掉再点开，评过的词应消失
（`dueAt` 已推到 3 天后）；点「🐞 造到期」立刻又能看到它们。

## 目录

```
src/index.ts              宿主半边：词表装载、调度、落盘、HTTP
lib/client.js             浏览器半边：胶囊 + 卡片（__ModuleLoader__ 形态）
scripts/build-wordbooks.mjs  原始资料 → data/cet4.json / data/cet6.json
scripts/build-deck.mjs       原始资料 → data/deck.json（音标/例句富化）
data/cet4.json            4544 词 / 412 KB
data/cet6.json            3991 词 / 354 KB
data/deck.json            47 张富化卡（只作富化来源）
cordis.patch.yml          bundle 层：insert dsh-vocab-plugin
dist/index.js             tsc 产物
```

## 开发

```bash
export PATH=/Users/yao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH

pnpm run build         # tsc → dist/
pnpm run build:words   # 重新派生词表（原始资料只读）
pnpm run build:deck    # 重新抓音标/例句（会撞词典 API 限流）
```

**踩过的两个坑**：

1. `webServer.register({ kind: 'prefix', path: '/x/api/' })` 带结尾斜杠时宿主不会路由过去
   （表现：页面 `HTTP 404`、胶囊 0 词）。写成 `/x/api` 即正常。
2. `slots.register` 的 `name` **必须是槽位键本身**（`{ name: 'conversation.input.left', id: '…' }`），
   填自定义 id 会静默落到不存在的槽、什么都不渲染。改完 `lib/client.js` 必须**重启桌面端**：
   宿主启动时把 bundle 字节快照进内存（本机未装 `dsh-client-hmr`），刷新页面不会换包。

## 已知限制

- 调度是固定间隔（3 天 / 1 天 / 明天），不是 FSRS：没有难度因子、没有稳定度记忆；
- 「明天 00:00」按本机时区算，跨时区旅行会让到期瞬间偏移；
- 已入队的卡不会因为改系统时间而重算（只有 `/next` 新追加时才重新判到期）；
- 只有 47 个词有例句，其余词背面只有释义；
- 音标已按要求从界面移除（数据里仍保留，需要时可再露出来）。

## License

[MIT](./LICENSE) © 2026 [chouxi-yao](https://github.com/chouxi-yao)

词表派生自 `原始资料/3-CET4-顺序.json` 与 `4-CET6-顺序.json`（该目录只读、未随仓库提交）；
`data/` 下只保留插件运行时需要的词形与释义，不含原书全部字段。例句与音标来自
[dictionaryapi.dev](https://dictionaryapi.dev/) 的公开数据，仅为学习用途。
