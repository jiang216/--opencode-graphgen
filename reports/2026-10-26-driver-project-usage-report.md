# graphgen MCP 实机观测报告：真实项目为何全程 0 次调用

> 测试日期：2026-10-26
> 插件版本：opencode-graphgen **0.3.0**（仓库 `F:\shiyan\CLion\opencode-graphgen` @ `d57b32b`）
> 引擎：`C:\Users\Administrator\.config\opencode\graphgen-mcp\engine`，Python 3.14.6，`autoDeploy=on`
> 被测项目：`J:\ShiYan\CLion\temp`（C / Windows KMDF 驱动骨架，非 git 仓库，无 `docs/`）
> 报告类型：外部使用观测（不是单元测试，是"真实任务里它会不会被想起/能不能用"的验证）

---

## 1. 测试场景

任务是一条完整的真实链路：在一个空的 C 工程里打通 Windows 内核驱动编译。

| 阶段 | 实际做的事 | 是否涉及"文档图谱" |
|---|---|---|
| 1 | 探测 VS / SDK / WDK 状态 | 否 |
| 2 | 装 Windows SDK 10.0.28000 | 否 |
| 3 | WDK 用官方 NuGet 包补齐（`wdksetup.exe` 走不动） | 否 |
| 4 | 修 `DemoDriver.vcxproj`：Spectre、签名、InfVerif、Inf2Cat | 否 |
| 5 | 修 `build.ps1`：`-VsInstallationPath`、64 位 MSBuild | 否 |
| 6 | 跑通 Debug/Release，产出 `.sys` + `.exe` | 否 |

**结论：整个会话 graphgen 调用 0 次。** 这不是"漏调"，而是当次所有触发条件都不成立——
但正是这种"条件都不成立"的场景占了日常开发的大多数，值得插件侧关注。

### 1.1 什么情况下我们会调 graphgen（本次没有命中的原因）

| 触发条件 | 本次是否命中 |
|---|---|
| 有 `docs/graph.json` / `DG-` `BUG-` `DOC-` 条目 | ✗ 项目里根本没有 docs |
| 改了文档，需要重生成图谱 | ✗ 只改了代码与工程文件 |
| 需要按条目 ID 查正反链 | ✗ 没有条目 |
| git 提交前后跑 `verify` / `links` / `snapshot` | ✗ 项目不是 git 仓库 |
| 全局 AGENTS 里的 `check-changed.ps1`（含 graphgen） | ✗ 那是 PHP 项目的收尾流程 |

---

## 2. 关键结论（TL;DR）

1. **工具没被触发，是因为"未接入"没有被任何机制提示出来**：`needsDeploy=true` 只是 `status` 返回体里的一个字段，没有任何一条"你现在该部署"的声音。
2. **`repo action=detect` 不是只读的**：它触发了完整 bootstrap 部署（22 条操作、写 7 个工具文件 + 3 个配置 + 2 个快照 + 改 `.gitignore`）。这直接导致了同目录并发的 `query check` 报"目标正在被另一个进程部署"。
3. **非 VCS 项目当前是"静默空转"**：`vcs: null` 之后 repo 系列没有任何降级说明，文档图谱能力也被一起放弃。
4. **条目 ID 文化门槛过高**：`links` 扫完 5 个提交，只得到一句"未发现条目 ID"，没有可执行的引导。
5. 对"纯编译/工具链排错"类任务，graphgen 当前**收益接近 0、接入成本不为 0**，这是它被跳过的根本原因——这一点需要在产品定位上说清楚（见 §5 P2-4）。
6. **部署成功 ≠ 可用**：`deploy` 返回 `ok:true` 后，第一次 `generate` 必报 `entry file not found: docs/CHANGELOG.md`；补完条目还撞「未知前缀」，补完文档还有孤儿警告——全新接入一共 4 个手工决策点，全部卡在"第一条条目"（见 §3.7）。

---

## 3. 现场证据

### 3.1 驱动工程侧：`graphgen_status`

```json
{
  "project": {
    "root": "J:\\ShiYan\\CLion\\temp",
    "engineReady": true,
    "installed": false,
    "missing": [
      "tools/graphgen.py", "tools/graphgen.config.template.json",
      "tools/doclint.py", "tools/gen_doc_slice.py",
      "tools/repo.py", "tools/repo.config.template.json",
      ".opencode/skills/graphgen/SKILL.md"
    ],
    "stale": [],
    "missingConfigs": [
      "tools/graphgen.config.json",
      "tools/doclint.config.json",
      "tools/repo.config.json"
    ],
    "needsDeploy": true,
    "snapshot": { "json": false, "markdown": false },
    "plugin": false, "skill": false, "agents": false,
    "vcs": null
  }
}
```

> 解读：引擎是好的，项目侧"零安装"。`needsDeploy: true` 这个信号只存在于返回体里，
> agent 不主动查就永远看不到。

### 3.2 插件仓库侧：部署前后对比

同一台机器，对 `F:\shiyan\CLion\opencode-graphgen` 调用 `repo action=detect` 后：

```json
{
  "installed": true, "missing": [], "stale": [], "missingConfigs": [],
  "needsDeploy": false,
  "snapshot": { "json": true, "markdown": true },
  "skill": true, "agents": true
}
```

两次调用的返回结构完全一致，差别只在 `installed` / `needsDeploy`——
**对 agent 来说，`detect` 的返回值里没有任何字段暗示"刚刚发生了写盘"。**

### 3.3 `repo detect` 的实际副作用（22 条操作）

```
copy  tools\graphgen.py
copy  tools\graphgen.config.template.json
new   tools\graphgen.config.json（由模板生成, name=opencode-graphgen）
skip  插件（MCP 模式默认不装；--plugin 安装文件监听插件）
copy  .opencode\skills\graphgen\（1 项）
copy  tools\doclint.py
copy  tools\gen_doc_slice.py
new   tools\doclint.config.json（示例配置，按项目裁剪规则开关/配参）
copy  tools\repo.py
copy  tools\repo.config.template.json
new   tools\repo.config.json（缺省配置；护栏默认只警告）
repo  git 仓库已存在（F:\shiyan\CLion\opencode-graphgen）
git   main @ d57b32b · 5 处改动（暂存 0 / 未暂存 0 / 未跟踪 5）
snapshot  git main @ d57b32b
snapshot  写入 docs/repo.json / docs/REPO.md
repo   .gitignore 已补充部署快照忽略项
links  扫描 5 提交，未发现条目 ID（提交信息里写 DG-009 之类即可关联）
links  写入 docs/repo-links.json
upd   tools\doclint.config.json（启用 R8 部署快照校验）
upd   tools\graphgen.config.json（启用 repo 块 + 快照产物免扫描）
skip  钩子（未加 --hooks）
skip  AGENTS.md（已有安装标记）
```

产生的仓库改动（**当时按用户要求保留，作为证据**）：

```
 M .gitignore                     (+4 行)
?? .opencode/                     (skills/graphgen)
?? docs/                          (repo.json / repo-links.json / REPO.md)
?? tools/doclint.config.json
?? tools/graphgen.config.json
?? tools/repo.config.json
```

> **20:0x 复查更正**：上述文件现已全部不存在，工作区干净（`git status` 无输出）。
> 清理动作不是本次会话做的——同日插件侧有提交 `8819702 feat(mcp): 首次自动部署增加冲突预检与无 VCS 降级`、
> `e98be77 fix(mcp): 安装完成后提示 opencode reload`，部署产物应是在这轮升级/回滚中一并移除的。
> 因此下面的文件清单按「历史事实」保留，不再作为可复查的现场。

### 3.4 并发锁：一次读操作被部署锁挡住

`detect` 部署进行中时，对同一目录的 `query action=check`：

```
错误: 目标正在被另一个进程部署
（锁: F:\shiyan\CLion\opencode-graphgen\.graphgen-deploy.lock）
如确认无进程，可删除该文件后重试
```

> 锁本身是合理的，问题在于：**只读操作（check/status）不应该被部署锁拒绝**，
> 且锁文件里没有 pid / 时间戳 / 超时，用户无法判断是"真的在部署"还是"上次崩溃残留"。

### 3.5 `links` 的引导强度不足

```
links  扫描 5 提交，未发现条目 ID（提交信息里写 DG-009 之类即可关联）
```

提示是准确的，但它出现在 **用户并不打算用条目体系** 的时候——
没有给出"要不要现在建几条种子条目 / 要不要装 commit-msg 钩子"的分支。

### 3.6 会话时间线（用于复现环境）

| 时间 | 事件 |
|---|---|
| 17:2x | 探测环境：VS 2026 18.6.2、SDK 26100、无 WDK、无 git 仓库 |
| 17:3x | SDK 28000 web 安装器报 `0x80091007`；改用 ISO |
| 18:0x–18:5x | CDN 限流，ISO 分片下载反复 400；改为 NuGet 补 WDK |
| 18:5x | 驱动 Debug / Release 编译通过（`DemoDriver.sys` + `democtl.exe`） |
| 19:0x | 本次 graphgen 观测：status / detect / check |
| 19:1x | 驱动工程里的自动部署产物消失（`AGENTS.md`/`tools/`/`docs/` 均不存在） |
| 19:5x | 按新版指令补部署 → 首次 `generate` 报 1 error → 补 `CHANGELOG.md` + 功能文档后转绿 |

### 3.7 补充观测（19:5x 复测）：部署成功 ≠ 可生成，首次 `generate` 必败

按新版指令执行 `graphgen_deploy {confirm:true, vcs:"none"}`，日志尾部明确 `new AGENTS.md`、9 个工具/配置文件、`.opencode/skills/graphgen/`，返回 `ok: true`。紧接着 `query action=generate`：

```
[graphgen] wrote J:/ShiYan/CLion/temp/docs/graph.json
[graphgen] wrote .../GRAPH.md
[graphgen] wrote .../graph.mmd
[graphgen] done: 2 nodes, 1 edges, 1 errors, 0 warnings

[stderr]
ERROR: entry file not found: docs/CHANGELOG.md
```

原因很直接：模板 `entryFiles` 指向 `docs/CHANGELOG.md`，而**部署过程不创建这个文件**。也就是说，任何"全新接入"的项目，第一次构建图谱都是失败态。

补两份文档后才转绿：

| 补齐物 | 作用 |
|---|---|
| `docs/CHANGELOG.md`（DG-001…DG-004） | 满足 `entryFiles.heading` + R7（编号连续、标题带日期） |
| `docs/DRIVER.md`（功能文档 + 7 条回归清单） | 消除 4 条「孤儿条目（无任何文档引用）」警告 |

补齐后：`generate` / `check` = **7 nodes / 9 edges / 0 errors / 0 warnings**，`doclint` = `OK`。

> **对插件开发的含义**：`deploy` 的 `ok:true` 不代表接入完成，真正的验收点是紧接着的 `generate` 返回码。
> 若 `deploy` 能顺带落一个最小 `CHANGELOG.md`（注释 + 一条占位条目），冷启动失败率可直接归零。

顺带一条配置观察：模板生成的 `tools/graphgen.config.json` 里 `prefixes: {}` 为空，
而 `entryFiles` 又要求 `[A-Z]+-\d+` 形式的条目 ID —— 首次写 `DG-001` 会立刻报
`未知前缀: DG`。也就是说「用哪个前缀」必须由人先改配置，才能写第一条。

### 3.8 复测：指令与工具在同一天内被更新（部分建议已落地）

19:5x 复测时，MCP 侧行为与报告成文时（19:0x）已不同：

| 观察点 | 报告成文时 | 复测时 |
|---|---|---|
| `status` 返回 | 只有 `needsDeploy` | 增加 `suggestedNextActions`（3 条可直接执行的命令） |
| 部署入口 | `repo detect` 隐式部署 | 独立 `graphgen_deploy`，带 `dryRun`/`confirm`/`force`/`snapshot` |
| 冲突预检 | 无 | `conflicts` 数组，非空需 `force:true` |
| 非 VCS | 静默空转 | `vcs:"none"` 时明确 `skip 代码仓库管理`，`status` 提示「repo status 返回 not_applicable」 |
| `prefixes` | 未涉及 | 仍需人工配置，否则首条条目报「未知前缀」（20:0x 已修复，见 §3.9） |

结论：P0-1（只读探测）、P0-2（`suggestedNextActions`）、P0-4（非 VCS 降级）的方向**已被采纳**；
本次新增的 P0-3 证据（首次 `generate` 必败）已按 P0 最小闭环修复（见 §3.9）。

### 3.9 修复复测（P0 最小闭环）：首次部署自带种子条目

已按 §3.7 的根因修复，不再要求用户先手写条目文件：

| 改动 | 行为 |
|---|---|
| `install.py` 新增 `ensure_docs_scaffold` | 在写 `AGENTS.md` **之前**检查 `entryFiles`；缺 `docs/CHANGELOG.md` 时写入一条合法种子 `DG-001`（已有前缀则沿用），并补 `prefixes: {"DG":"变更"}` 与 `allowOrphanEntries:["DG-001"]` |
| 已有条目文件 | 不覆盖、不追加；文件存在但没有合法条目时 `docs.ready=false`，跳过 `AGENTS.md`，避免规则先于数据落地 |
| `mcp/status` | 增加 `docs.ready` / `missingEntryFiles` / `invalidEntryFiles`；最新建议可直接指向 `deploy` 或补条目 |
| `mcp/query generate/check/doclint` | 先做 entry 预检；未就绪返回结构化 `needsDocs`，不再把 Python 的 `ERROR: entry file not found` 直接抛给用户 |
| `tools/graphgen.py` | 支持 `allowOrphanEntries`，只豁免显式登记的种子条目，不吞真实业务条目的孤儿警告 |

**复测（20:0x，全新临时项目）**：

```text
new   .../docs/CHANGELOG.md（种子条目 DG-001）
upd   .../tools/graphgen.config.json（补默认前缀/种子条目豁免）
[graphgen] done: 3 nodes, 1 edges, 0 errors, 0 warnings
[graphgen] check: 3 nodes, 1 edges, 0 errors, 0 warnings
doclint: OK
```

二次 `install.py` 输出 `skip .../docs/CHANGELOG.md（已存在合法条目）`，文件哈希不变；
`node mcp/mcp-test.mjs` = **PASS=50 / FAIL=0**，覆盖空项目自动部署、种子落盘、已有 CHANGELOG 不覆盖、
空条目文件返回 `needsDocs`、二次部署幂等。

**既有项目回归（同步安装运行时后）**：对 `J:\ShiYan\CLion\temp`（已有 `DG-001..DG-004`）
执行 `graphgen_deploy {confirm:true, vcs:"none"}`，日志为 `skip .../docs/CHANGELOG.md（已存在合法条目）`，
`docs.ready=true / seeded=false`；随后 `check` = **7 nodes / 9 edges / 0 errors / 0 warnings**，
`doclint: OK`。说明种子逻辑不会改动已有关联文档的项目。

**边界与未做**：P0 只解决“从 0 到可生成”，没有实现完整 `adopt`——仍不会从 `README.md`
自动切出 3–5 条业务种子，也不按项目语言自动检测前缀（默认 `DG`）。这两项保留到 `adopt` 阶段；
当前项目若已有 `CHANGELOG.md` 但无合法条目，部署器只提示、不擅自改写用户文件。

### 3.10 后续落地：git 身份确认 + 默认建库（2026-10-26）

按“首次建库让用户输入身份、确认后以后项目不再问”的需求，MCP 侧已补：

| 改动 | 行为 |
|---|---|
| `mcp/config.json` 新增 `identity` | `{name,email,remember}`；只存 name/email，不存密码/PAT/token |
| `deploy` 新增 `identity` / `rememberIdentity` | agent 对话询问后传入；`remember=true` 写入全局配置并打开 `vcsInit/vcsCommit` |
| 无身份时的部署 | 先补 tools/docs，返回 `needsIdentity`，**不偷偷 `git init`** |
| 已记住身份后的自动部署 | 按 `deploy.vcsInit/vcsCommit` 直接建库 + 首次提交，不再询问 |
| `install.py` / `repo.py` | 新增 `--git-name/--git-email`，在首次提交前写入当前仓库 **local** 身份，不碰全局 git config |
| `status` | 返回 `identity.configured/remember`、`needsIdentity` / `needsRemember` 和配置路径，便于 agent 询问 |

验证：`node mcp/mcp-test.mjs` = **PASS=58 / FAIL=0**；覆盖“缺身份不建库、一次性身份、
remember 后第二个项目自动建库、配置无密码字段”。已同步安装运行时并 `opencode reload`；
`opencode mcp list` 显示 graphgen connected。当前 `J:\ShiYan\CLion\temp` 仍无身份，
`status` 返回 `needsIdentity=true`，等待用户提供 `user.name` / `user.email` 后执行首次建库。

---

## 4. 原因分析（按"为什么会漏"的层次）

### 4.1 任务类型层：graphgen 是"文档/条目驱动"的工具

它的四类动作全都锚定在 `docs/graph.json` + 条目 ID + 提交史上：

| 动作 | 依赖 | 本任务 |
|---|---|---|
| `query` / `generate` | 图谱 + 条目 | 无 |
| `check` / `doclint` | 文档正文 + 规则 | 无 |
| `repo status/links/snapshot` | 版本库 | 非 git |
| `verify` | 以上三者 | 全不适用 |

对"装工具链 / 编译排错"这类任务，**没有任何一条路径会自然走到 graphgen**。

### 4.2 接入层：未部署，且没人提示

`needsDeploy: true` 是唯一信号，而它：
- 只在 `status` 里出现，不主动推送；
- 不告诉 agent"下一条命令是什么"；
- 部署本身要 `confirm: true`，属于"要用户拍板"的操作，agent 更不会主动做。

> 19:5x 复测：前两条已解决（`suggestedNextActions` 返回可直接执行的命令），第三条仍是设计上的张力——
> MCP 指令要求「`conflicts=[]` 时直接 `deploy confirm:true`」，但 `deploy` 语义上又写着"写盘需确认"。
> 二者并存时，agent 容易停在"我已经 status 过了"。建议在 `status` 的返回里直接标注
> `autoSafe: true`（表示无冲突、可直接部署），把判断从文档挪到数据里。

### 4.3 版本库层：非 git 项目直接失去一半能力

`vcs: null` 之后，`repo *` 全是空转，`verify` 里的 repo 段也失去意义。
而"先写代码后建库"在实验性工程里非常常见（本次就是）。

### 4.4 发现层：Code Mode 下 MCP 工具要 `search()` 才可见

在 Code Mode 里我只看到"graphgen (5 tools, 4 shown)"这一行目录信息，
真正调用必须先 `search("graphgen")` 再按 `path` 调。
本会话没有一次 `search` 到 graphgen——**工具连"被看见"都没发生**。

### 4.5 文档层：全局触发点绑死在 PHP 项目

全局 `AGENTS.md` 里唯一提到 graphgen 的地方是：

> 改完跑 `tools/check-changed.ps1`（PHP lint + `git diff --check` + graphgen）再提交。

对 C / 驱动 / Node 项目，这句话不适用，也没有替代条款。

---

## 5. 对插件开发的建议

> 每条给出：**现状 → 期望 → 实现提示**。P0 是会直接影响"能不能被用起来"的。

### P0-1 `detect` / `status` 必须严格只读

- **现状**：`repo action=detect` 触发 bootstrap，写 7 文件 + 3 配置 + 2 快照 + 改 `.gitignore`。
- **期望**：`detect` 只返回 `{vcs, installed, needsDeploy, missing}`；任何落盘都走 `deploy {confirm:true}`。
- **实现提示**：把 bootstrap 调用从 `detect` 分支挪到 `deploy`；`detect` 只做 `os.path.exists` 级探测；
  已有部署则退化为纯读（本次第二次 detect 就只做了 snapshot 重写，行为仍不一致）。

### P0-2 `status` 要给出"下一步命令"

- **现状**：`needsDeploy: true` 是个死字段。
- **期望**：
  ```json
  "suggestedNextActions": [
    "graphgen_deploy { target: \"J:/ShiYan/CLion/temp\", confirm: true }"
  ]
  ```
- **实现提示**：在 `status` 的 project 段加数组，由 `needsDeploy` / `missing` / `vcs` 三态组合生成；
  文案要能直接复制执行。
- **复测状态（19:5x）**：已落地。`status` 现在返回 3 条，除 `graphgen_deploy` 外还包括
  「部署后生成图谱」与「无 VCS 时 repo status 返回 not_applicable」的提示，见 §3.8。

### P0-3 提供 `adopt`：一条命令完成"接入"

- **现状**：部署 → 建 docs → generate 是三步，且第二步（条目）需要人写。
- **复测证据（19:5x）**：这条已从"推测"变成"实测"——`deploy` 返回 `ok:true` 之后，
  紧接着的 `generate` **必然**报 `ERROR: entry file not found: docs/CHANGELOG.md`（1 error），
  因为模板 `entryFiles` 指向的条目文件不在部署产物里（详见 §3.7）。
  补 `CHANGELOG.md` 后又因 `prefixes: {}` 报「未知前缀: DG」，必须再改配置；
  最后还要补一份引用条目的功能文档，否则留下 4 条「孤儿条目」警告。
  **一次全新接入 = 4 个手工决策点，全部卡在"第一条条目"上。**
- **期望**：`graphgen_adopt {target}` = deploy + 扫 README/目录树生成 3–5 条种子条目 + generate。
- **实现提示**：种子条目可以从 `README.md` 的二级标题自动切分（`DOC-001..00N`），
  让 `graph.json` 立刻非空，后续再人工细化。同时按项目语言自动写入 `prefixes`
  （C/驱动 → `DG`、前端 → `FE` 等），避免首条就撞「未知前缀」。
- **实现状态（20:0x）**：P0 最小闭环已完成，但**不是**完整的 `adopt`。首次 `deploy` 现在会写
  一条合法种子（`DG-001`）、补默认 `prefixes` 和 `allowOrphanEntries`，随后 `generate` 直接
  0 errors / 0 warnings；已有 `CHANGELOG.md` 不覆盖，空条目文件返回 `needsDocs`。验收见 §3.9。
  仍待做：扫描 README 自动生成 3–5 条业务条目、按语言检测前缀。为避免为了凑条数伪造 changelog，
  这部分没有硬塞进 P0。

### P0-4 非 VCS 项目的降级模式

- **现状**：`vcs: null` 后 repo 系列无输出、无说明。
- **期望**：`repo *` 明确返回 `{"status":"not_applicable","reason":"no_vcs"}`；
  同时提供文件系统快照（`path + mtime + sha256`），让"文档图谱 + 漂移校验"在无 git 项目里仍可用。
- **实现提示**：`snapshot` 增加 `mode: "vcs" | "fs"`；`links` 在 fs 模式下改为"按文件变更时间关联条目"。

### P1-1 锁文件要有身份与超时

- **现状**：`.graphgen-deploy.lock` 只有存在性；读操作（check）也被拒绝。
- **期望**：锁内容含 `pid / host / started_at / ttl`；`status`、`query` 读操作不加锁；
  过期锁（>10 min 且 pid 不存在）自动清理。
- **实现提示**：写 JSON 进锁文件；`psutil`/`tasklist` 判活；`deploy --force` 覆盖。

### P1-2 提高"被想起"的概率

- **现状**：Code Mode 里 MCP 需 `search()` 才暴露；`SKILL.md` 里没有"第一步做什么"。
- **期望**：`SKILL.md` 顶部固定一段"进入任意项目的第一动作 = `graphgen_status`"；
  MCP instructions 的"路由"第一条就是它（目前第一条是"新项目/第一次用"）。
- **实现提示**：在服务端 `initialize.instructions` 里把"新项目 → status"提到最前，
  并给出"status 返回 needsDeploy=true 时该说什么"的标准话术。

### P1-3 语言无关的接入片段

- **现状**：AGENTS 模板里 graphgen 的唯一触发点是 PHP 的 `check-changed.ps1`。
- **期望**：给 CMake / Node / Python / 驱动工程的 3 步片段：
  `deploy` → `generate` → "提交前 `verify`"。
- **实现提示**：把现有 PHP 片段抽象成 `提交前动作` 变量，按项目类型注入。

### P1-4 条目 ID：从"提示"升级为"可执行"

- **现状**：`links` 只说"提交信息里写 DG-009 即可关联"。
- **期望**：检测到零条目时，主动给出两个选项：
  1. `graphgen_repo guard --stage commit-msg`（装钩子，提交时校验 ID 格式）；
  2. 生成 `.gitmessage` 模板。
- **实现提示**：`links` 的返回体加 `suggestions: [...]`，与 P0-2 同一套机制。

### P2-1 `docs/` 的语义要拆开

- **现状**：部署后 `docs/` 只有 `repo.json / REPO.md`，**没有 `graph.json`**，
  很容易被理解成"图谱已经生成了"（本次我就先入为主地去找 `docs/graph.json`）。
- **期望**：`status` 明确区分 `graph: not_generated` 与 `repo_snapshot: ok`；
  或把快照类产物移到 `.graphgen/`。
- **实现提示**：repo 快照与文档图谱分目录，`status` 各给一行状态。

### P2-2 部署输出要可预览

- **现状**：22 条操作一次性执行，copy/new/skip/upd 混在一起。
- **期望**：默认先打印 diff 摘要并等待确认；`--dry-run` 至少要在 `deploy` 上是一等公民。
- **实现提示**：把本次 `report.summary` 的计数（copy/new/skip/upd）先输出，再执行。

### P2-3 引擎版本与仓库版本的一致性检查

- **现状**：本机同时存在引擎（`.config\opencode\graphgen-mcp\engine`）、
  源目录（`F:\ProgramFiles\opencode-graphgen-0.3.0`）、仓库（`F:\shiyan\CLion\opencode-graphgen`），
  `status` 只报引擎版本，不报三者是否同源。
- **期望**：`doctor` 增加"引擎 vs 仓库 HEAD 是否一致"，不一致时警告。
- **实现提示**：引擎目录写入构建时的 commit，运行时与仓库 `git rev-parse HEAD` 比对。

### P2-4 在文档里说清楚"什么时候**不**该用"

- **现状**：所有材料都在讲"怎么用"，没有讲"什么任务别用"。
- **期望**：明确写出适用范围——**有文档/条目、有提交节奏的项目**；
  对"纯编译排错 / 一次性实验工程"，明确说"可以不用，别为了用而用"。
- **理由**：本次就是典型反例；把边界写清楚，反而能提升工具在真正适用场景里的信任度。

---

## 6. 复现步骤

```powershell
# 1) 看一个未接入的项目（应只读，不产生任何文件）
#    观察到：installed=false, needsDeploy=true, vcs=null
graphgen_status { root: "J:/ShiYan/CLion/temp" }

# 2) 对一个已安装的仓库触发探测
#    观察到：22 条 copy/new/skip/upd，写入 docs/、tools/*.config.json，修改 .gitignore
graphgen_repo { action: "detect", root: "F:/shiyan/CLion/opencode-graphgen" }

# 3) 部署进行中并发调用只读检查
#    观察到：报错"目标正在被另一个进程部署（锁: .../.graphgen-deploy.lock）"
graphgen_query { action: "check", root: "F:/shiyan/CLion/opencode-graphgen" }

# 4) 部署完成后再查 links
#    观察到：扫描 5 个提交，无条目 ID
```

期望的修复后行为：

| 步骤 | 期望 |
|---|---|
| 1 | 返回 `suggestedNextActions`，指向 `graphgen_deploy` |
| 2 | 只返回探测结果，零写盘 |
| 3 | 正常返回（读操作不受部署锁影响），或返回"部署中，稍后重试"且带 ttl |
| 4 | 返回零条目 + 两条可执行建议（钩子 / 模板） |

---

## 7. 附录 A：本次曾产生的部署产物（留档；20:0x 复查时已被回滚）

| 路径 | 说明 |
|---|---|
| `.opencode/skills/graphgen/` | 部署的技能文件 |
| `docs/repo.json` | 仓库快照（git main @ d57b32b） |
| `docs/repo-links.json` | 提交↔条目关联扫描结果（本次为空） |
| `docs/REPO.md` | 快照的 markdown 视图 |
| `tools/graphgen.config.json` | 生成的配置（已启用 repo 块） |
| `tools/doclint.config.json` | 生成的配置（已启用 R8 部署快照校验） |
| `tools/repo.config.json` | 生成的配置（护栏默认只警告） |
| `.gitignore` | +4 行，快照忽略项 |

> 截至 20:0x，以上文件均**已被移除**（工作区干净）。移除发生在同日插件升级（`8819702` / `e98be77`）过程中，
> 不是本次会话主动回滚；本表仅作为"部署会产生什么"的留档。
> 顺带说明：这也意味着**部署产物没有自愈/自清理的可见性**——文件消失时，用户/agent 只能靠 `git status` 发现，
> 建议 `deploy` 在 `status` 里记录「上次部署时间 + 部署指纹」，便于判断"被谁清掉了"。

历史回滚命令（已不需要执行，留作参考）：

```powershell
cd F:\shiyan\CLion\opencode-graphgen
git checkout -- .gitignore
Remove-Item -Recurse -Force .opencode, docs
Remove-Item tools\doclint.config.json, tools\graphgen.config.json, tools\repo.config.json
```

---

## 8. 附录 B：环境与版本

| 项 | 值 |
|---|---|
| 引擎版本 | graphgen 0.3.0 |
| 引擎路径 | `C:\Users\Administrator\.config\opencode\graphgen-mcp\engine` |
| 引擎源 | `F:\ProgramFiles\opencode-graphgen-0.3.0` |
| 仓库 | `F:\shiyan\CLion\opencode-graphgen` @ `d57b32b`（2026-10-26） |
| MCP 服务端 | `libs`（25 工具）/ `graphgen`（5 工具，4 暴露）/ `rea` |
| Python | 3.14.6 |
| 被测工程 | VS 2026 18.6.2 + Windows SDK 10.0.28000 + WDK 10.0.28000（NuGet 补齐） |
| 被测工程语言 | C（KMDF 内核驱动）+ PowerShell 构建脚本 |
| 被测工程 VCS | 无（非 git 仓库） |

---

## 9. 附录 C：修复验收标准（建议写进测试用例）

1. `repo detect` 在未部署目录上执行后，`git status` **无新增文件**、`needsDeploy` 仍为 `true`。
2. `status` 对未部署目录返回非空 `suggestedNextActions`，且命令可直接执行成功。
3. 部署进行中调用 `query check` **不报锁错**；锁文件含 `pid` / `started_at` / `ttl`。
4. 非 git 目录下 `repo status` 返回 `not_applicable` 而不是空结果；`snapshot` 走 `mode=fs`。
5. 零条目时 `links` 返回至少 2 条 `suggestions`。
6. `adopt` 在空项目上能在 1 条命令内产出非空 `graph.json`（含 3–5 条种子条目）。
