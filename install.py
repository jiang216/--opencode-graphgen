#!/usr/bin/env python3
"""opencode-graphgen 统一安装器 — 把全家桶幂等装进目标项目。

用法:
  python install.py --target F:\\path\\to\\project [--hooks] [--vcs auto|git|hg|svn|none]

做什么（重复执行安全，已存在即覆盖=同步更新）:
  1. tools/graphgen.py、tools/graphgen.config.template.json  → <target>/tools/
     <target>/tools/graphgen.config.json 不存在时由模板生成（name=目录名）
  2. src/index.ts（插件）                                     → <target>/.opencode/plugins/graphgen-watch.ts
  3. skills/graphgen/                                        → <target>/.opencode/skills/graphgen/
  4. tools/doclint.py、tools/gen_doc_slice.py                → <target>/tools/
  5. tools/doclint.config.json 不存在时由 templates/doclint.config.example.json 生成
  6. tools/repo.py（代码仓库适配层）+ tools/repo.config.template.json → <target>/tools/
     <target>/tools/repo.config.json 不存在时由模板生成
  7. docs/CHANGELOG.md 缺失时写入一条合法种子条目（DG-001 或已有前缀），
     并补 prefixes / allowOrphanEntries；entryFiles 未就绪时不写 AGENTS
  8. 代码仓库管理（--vcs none 可整步跳过）:
     a. 检测 .git/.hg/.svn；已是仓库 → 只体检（分支/HEAD/工作区），绝不重建
     b. 无仓库 + 有 git/hg/svn → 默认自动建库（git init -b main + 播种 .gitignore）
        svn 需 --vcs-remote <URL>，不在本地凭空造库
     c. 无任何 VCS 工具 → 打印安装指引，不失败（--vcs-strict 时退出码 1）
     d. 建库/检出成功 → 生成 docs/repo.json + docs/REPO.md 部署快照、
        docs/repo-links.json 条目↔提交索引，并打开 doclint R8 / graphgen repo 块
  9. <target>/.opencode/package.json 保证依赖 @opencode/plugin（V2，缺则建/补；
     同时移除 V1 残留依赖 @opencode-ai/plugin）
 10. --hooks: templates/pre-commit + templates/commit-msg → <target>/tools/git-hooks/
                且 target 自身是仓库根时设 core.hooksPath=tools/git-hooks
                （在父仓库内只装文件，不改父仓库配置）
 11. AGENTS.md 追加模板片段（已有 <!-- graphgen:installed --> 标记则跳过；
     entryFiles 未就绪时跳过，避免写入无法执行的工作流）

退出码：0=成功 1=失败（--vcs-strict 且缺 VCS 工具时也算失败）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent

PLUGIN_DEP = {"@opencode/plugin": "2.0.32"}
PLUGIN_STALE_DEPS = ("@opencode-ai/plugin",)
MARKER = "<!-- graphgen:installed -->"
SNAPSHOT_JSON = "docs/repo.json"
SNAPSHOT_MD = "docs/REPO.md"
LINKS_JSON = "docs/repo-links.json"
PLUGIN_REL = ".opencode/plugins/graphgen-watch.ts"
DEFAULT_ENTRY_FILE = "docs/CHANGELOG.md"
DEFAULT_PREFIX = "DG"
DEFAULT_PREFIX_LABEL = "变更"
SEED_TITLE = "接入 graphgen 文档图谱"


@dataclass
class InstallOptions:
    """install_project() 的全部开关；CLI / MCP 共用。"""

    target: Path
    hooks: bool = False
    agents: bool = True
    vcs: str = "auto"
    vcs_init: bool = True
    vcs_remote: str = ""
    vcs_branch: str = ""
    vcs_commit: bool = False
    vcs_strict: bool = False
    snapshot: bool = True
    dry_run: bool = False
    plugin: bool = False
    remove_plugin: bool = False


# ---------------------------------------------------------------------------
# 文件与配置
# ---------------------------------------------------------------------------

def copy_file(src: Path, dst: Path) -> str:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return f"copy  {dst}"


def ensure_graphgen_config(target: Path) -> str:
    cfg = target / "tools" / "graphgen.config.json"
    if cfg.is_file():
        return f"skip  {cfg}（已存在）"
    tpl = (HERE / "tools" / "graphgen.config.template.json").read_text(encoding="utf-8")
    data = json.loads(tpl)
    data["name"] = target.name
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return f"new   {cfg}（由模板生成, name={target.name}）"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _entry_regex(entry_cfg: dict) -> re.Pattern[str]:
    raw = entry_cfg.get("heading", r"^([A-Z]+-\d+)\s*[:：]?\s*(.+)$")
    try:
        return re.compile(str(raw))
    except re.error:
        return re.compile(r"^([A-Z]+-\d+)\s*[:：]?\s*(.+)$")


def _entry_has_items(path: Path, entry_cfg: dict) -> bool:
    """条目文件里至少有一个 `##` 标题能匹配 entryFiles.heading。"""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return False
    entry_re = _entry_regex(entry_cfg)
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+)$", line.strip())
        if m and entry_re.match(m.group(1)):
            return True
    return False


def _entry_prefixes(text: str) -> list[str]:
    return sorted(set(re.findall(r"^##\s+([A-Z]+)-\d+\s*[:：]", text, re.M)))


def _ensure_seed_prefix(cfg: dict, text: str) -> str:
    """补默认前缀；已有条目则优先沿用条目里的前缀。返回种子条目应使用的前缀。"""
    prefixes = cfg.get("prefixes")
    if not isinstance(prefixes, dict):
        prefixes = {}
    for prefix in _entry_prefixes(text):
        prefixes.setdefault(
            prefix, DEFAULT_PREFIX_LABEL if prefix == DEFAULT_PREFIX else prefix
        )
    if not prefixes:
        prefixes[DEFAULT_PREFIX] = DEFAULT_PREFIX_LABEL
    cfg["prefixes"] = prefixes
    if DEFAULT_PREFIX in prefixes:
        return DEFAULT_PREFIX
    return sorted(prefixes)[0]


def ensure_docs_scaffold(target: Path) -> tuple[list[str], dict]:
    """首次部署先落一个合法条目文件，避免 AGENTS 规则先于数据落地。

    只创建缺失的 `docs/CHANGELOG.md`；已有文件绝不覆盖/追加。返回
    `(logs, docs_info)`，`docs_info["ready"]` 表示所有 entryFiles 都存在且有合法条目。
    """
    logs: list[str] = []
    info: dict = {
        "ready": False,
        "entryFiles": [],
        "missingEntryFiles": [],
        "invalidEntryFiles": [],
        "seedEntry": None,
        "seeded": False,
    }
    cfg_path = target / "tools" / "graphgen.config.json"
    if not cfg_path.is_file():
        logs.append(f"warn  {cfg_path} 缺失，跳过文档种子")
        return logs, info
    try:
        cfg = _load_json(cfg_path)
    except (OSError, UnicodeError, json.JSONDecodeError) as e:
        logs.append(f"warn  {cfg_path} 读取失败：{e}；跳过文档种子")
        return logs, info
    entry_files = cfg.get("entryFiles")
    if not isinstance(entry_files, dict) or not entry_files:
        logs.append("skip  文档种子（配置未声明 entryFiles）")
        info["ready"] = True
        return logs, info

    info["entryFiles"] = list(entry_files)
    before = json.dumps(cfg, ensure_ascii=False, sort_keys=True)
    text = ""

    seed_cfg = entry_files.get(DEFAULT_ENTRY_FILE)
    if isinstance(seed_cfg, dict):
        seed_path = target / DEFAULT_ENTRY_FILE
        if seed_path.is_file():
            try:
                text = seed_path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError) as e:
                logs.append(f"warn  {seed_path} 读取失败：{e}")
            if _entry_has_items(seed_path, seed_cfg):
                logs.append(f"skip  {seed_path}（已存在合法条目）")
            else:
                logs.append(
                    f"warn  {seed_path} 存在但未匹配到条目；不覆盖，请手工补一条或删除后重跑"
                )
            _ensure_seed_prefix(cfg, text)
        else:
            prefix = _ensure_seed_prefix(cfg, text)
            seed_id = f"{prefix}-001"
            today = date.today().isoformat()
            seed_path.parent.mkdir(parents=True, exist_ok=True)
            seed_path.write_text(
                f"""# 变更日志

<!-- 条目格式：## <前缀>-001: 标题（YYYY-MM-DD） -->

## {seed_id}: {SEED_TITLE}（{today}）

- 首次部署自动创建，作为文档图谱的种子条目。
- 后续功能/修复按同一格式追加；提交前运行 `python tools/graphgen.py --check` 与 `python tools/doclint.py`。

### 相关历史条目

- 无（首条）
""",
                encoding="utf-8",
            )
            allow = cfg.get("allowOrphanEntries")
            if isinstance(allow, str):
                allow = [allow]
            elif not isinstance(allow, list):
                allow = []
            if seed_id not in allow:
                allow.append(seed_id)
            cfg["allowOrphanEntries"] = allow
            info["seedEntry"] = seed_id
            info["seeded"] = True
            logs.append(f"new   {seed_path}（种子条目 {seed_id}）")

    missing: list[str] = []
    invalid: list[str] = []
    for rel, entry_cfg in entry_files.items():
        path = target / rel
        if not path.is_file():
            missing.append(rel)
            continue
        if isinstance(entry_cfg, dict) and not _entry_has_items(path, entry_cfg):
            invalid.append(rel)
    info["missingEntryFiles"] = missing
    info["invalidEntryFiles"] = invalid
    info["ready"] = not missing and not invalid
    if missing:
        logs.append("warn  entryFiles 缺失: " + ", ".join(missing))
    if invalid:
        logs.append("warn  entryFiles 无合法条目: " + ", ".join(invalid))

    after = json.dumps(cfg, ensure_ascii=False, sort_keys=True)
    if after != before:
        cfg_path.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        logs.append(f"upd   {cfg_path}（补默认前缀/种子条目豁免）")
    return logs, info


def ensure_doclint_config(target: Path) -> str:
    cfg = target / "tools" / "doclint.config.json"
    if cfg.is_file():
        return f"skip  {cfg}（已存在）"
    src = HERE / "templates" / "doclint.config.example.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, cfg)
    return f"new   {cfg}（示例配置，按项目裁剪规则开关/配参）"


def ensure_repo_config(target: Path) -> str:
    cfg = target / "tools" / "repo.config.json"
    if cfg.is_file():
        return f"skip  {cfg}（已存在）"
    src = HERE / "tools" / "repo.config.template.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, cfg)
    return f"new   {cfg}（缺省配置；护栏默认只警告）"


def ensure_package_json(target: Path) -> str:
    pkg = target / ".opencode" / "package.json"
    existed = pkg.is_file()
    changed = False
    if pkg.is_file():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return f"warn  {pkg} JSON 解析失败，未改动"
    else:
        data = {}
        changed = True
    deps = data.setdefault("dependencies", {})
    for k, v in PLUGIN_DEP.items():
        if k not in deps:
            deps[k] = v
            changed = True
    for k in PLUGIN_STALE_DEPS:
        if k in deps:
            del deps[k]
            changed = True
    if not data["dependencies"]:
        data.pop("dependencies", None)
        changed = True
    if changed:
        pkg.parent.mkdir(parents=True, exist_ok=True)
        pkg.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return f"{'upd ' if existed else 'new '} {pkg}"
    return f"skip  {pkg}（依赖已在）"


# ---------------------------------------------------------------------------
# 代码仓库管理（repo.py 驱动）
# ---------------------------------------------------------------------------

def run_repo(target: Path, *args: str) -> tuple[int, dict | None]:
    """调用目标项目内的 tools/repo.py（保证与部署版本一致），返回 (rc, json)。"""
    script = target / "tools" / "repo.py"
    if not script.is_file():
        return 1, None
    cmd = [sys.executable, str(script), *args, "--root", str(target), "--json"]
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=300, **kwargs,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, {"messages": [f"warn  repo.py 执行失败：{e}"]}
    text = (r.stdout or "").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        detail = (text or (r.stderr or "")).strip().replace("\n", " ")[:300]
        return r.returncode, {"messages": [f"warn  repo.py 输出无法解析：{detail}"]}
    if isinstance(data, dict):
        data.setdefault("_rc", r.returncode)
    return r.returncode, data


def _dirty_text(dirty: dict) -> str:
    if not dirty or not dirty.get("total"):
        return "工作区干净"
    return (f"{dirty['total']} 处改动（暂存 {dirty.get('staged', 0)} / "
            f"未暂存 {dirty.get('modified', 0)} / 未跟踪 {dirty.get('untracked', 0)}）")


def enable_repo_integrations(target: Path) -> list[str]:
    """打开 doclint R8 与 graphgen repo 块（缺省才写，尊重用户已有开关）。"""
    out: list[str] = []

    dl = target / "tools" / "doclint.config.json"
    if dl.is_file():
        try:
            cfg = json.loads(dl.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            cfg = None
        if isinstance(cfg, dict):
            rules = cfg.setdefault("rules", {})
            r8 = rules.get("R8")
            changed = False
            if not isinstance(r8, dict):
                rules["R8"] = {
                    "enable": True,
                    "snapshot": SNAPSHOT_MD,
                    "json": SNAPSHOT_JSON,
                    "_": "部署快照新鲜度：docs/REPO.md 记录的 HEAD 必须等于当前 HEAD",
                }
                changed = True
            else:
                for k, v in (("snapshot", SNAPSHOT_MD), ("json", SNAPSHOT_JSON)):
                    if k not in r8:
                        r8[k] = v
                        changed = True
            if changed:
                dl.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                out.append(f"upd   {dl}（启用 R8 部署快照校验）")
            else:
                out.append(f"skip  {dl}（R8 已在）")

    gg = target / "tools" / "graphgen.config.json"
    if gg.is_file():
        try:
            cfg = json.loads(gg.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            cfg = None
        if isinstance(cfg, dict):
            changed = False
            repo = cfg.get("repo")
            if not isinstance(repo, dict):
                cfg["repo"] = {
                    "enabled": True,
                    "linksFile": LINKS_JSON,
                    "snapshotMarkdown": SNAPSHOT_MD,
                    "maxCommitNodes": 300,
                    "_comment": "提交↔条目关联：由 tools/repo.py links 生成，graphgen 增加 COMMIT 节点与 touches 边；"
                                "不想用时置 keepDisabled=true",
                }
                changed = True
            else:
                # 安装器已确认仓库存在：默认打开（用户显式 keepDisabled 时尊重）
                if repo.get("enabled") is not True and not repo.get("keepDisabled"):
                    repo["enabled"] = True
                    changed = True
                for k, v in (("linksFile", LINKS_JSON), ("snapshotMarkdown", SNAPSHOT_MD), ("maxCommitNodes", 300)):
                    if k not in repo:
                        repo[k] = v
                        changed = True
            ignore = cfg.setdefault("scan", {}).setdefault("ignore", [])
            for p in (SNAPSHOT_MD, SNAPSHOT_JSON, LINKS_JSON):
                if p not in ignore and p.endswith(".md"):
                    ignore.append(p)
                    changed = True
            if changed:
                gg.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                out.append(f"upd   {gg}（启用 repo 块 + 快照产物免扫描）")
            else:
                out.append(f"skip  {gg}（repo 块已在）")
    return out


def ensure_vcs(target: Path, opts: InstallOptions) -> tuple[list[str], int]:
    out: list[str] = []
    if opts.vcs == "none":
        return ["skip  代码仓库管理（--vcs none）"], 0

    rc, info = run_repo(target, "detect")
    if info is None:
        return [f"warn  {target}/tools/repo.py 缺失，跳过代码仓库管理"], 0

    vcs = info.get("vcs") or ""
    if vcs:
        out.append(f"repo  {vcs} 仓库已存在（{target}）")
        rc, st = run_repo(target, "status")
        if st and st.get("result") == "ok":
            out.append(
                f"{vcs}   {st.get('branch') or '(no branch)'} @ "
                f"{st.get('headShort') or '(空仓库)'} · {_dirty_text(st.get('dirty', {}))}"
            )
            remotes = st.get("remotes") or []
            if remotes:
                out.append("      remote: " + "、".join(f"{r['name']}={r['url']}" for r in remotes))
        elif st:
            out.extend(st.get("messages") or [])
        if info.get("conflict"):
            out.append(
                f"warn  同时存在 {', '.join(info['conflict'])} 标记，按优先级使用 {vcs}"
                "（旧 VCS 目录未删除，确认后可手动清理）"
            )
    elif info.get("nested"):
        where = info.get("parentRoot")
        out.append(f"warn  目标位于 {info.get('parentVcs')} 仓库 {where} 内，不建嵌套库")
        out.append("       确需独立历史：python tools/repo.py init --allow-nested")
        return out, 0
    else:
        if not opts.vcs_init:
            out.append("skip  未检测到代码仓库（--no-vcs-init，不自动建库）")
            return out, 0
        init_args = ["init", "--vcs", opts.vcs]
        if opts.vcs_remote:
            init_args += ["--remote", opts.vcs_remote]
        if opts.vcs_branch:
            init_args += ["--branch", opts.vcs_branch]
        if opts.vcs_commit:
            init_args.append("--commit")
        if opts.dry_run:
            init_args.append("--dry-run")
        rc, res = run_repo(target, *init_args)
        res = res or {}
        out.extend(res.get("messages") or [f"warn  repo.py init 未返回结果（exit {rc}）"])
        if res.get("result") in ("no-tool", "needs-remote", "failed", "nested", "skip"):
            # 没有可用的仓库：不生成快照/索引，让用户先补齐工具或远端
            if opts.vcs_strict and res.get("result") == "no-tool":
                out.append("warn  --vcs-strict：缺少可用 VCS 工具，按失败处理（退出码 1）")
                return out, 1
            return out, 0
        if res.get("result") == "planned":
            return out, 0

    # 到这里一定已有仓库（原有或刚建）
    if opts.snapshot:
        rc, snap = run_repo(target, "snapshot")
        snap = snap or {}
        if snap.get("messages"):
            out.extend(snap["messages"])
        elif rc != 0:
            out.append(f"warn  部署快照生成失败（exit {rc}）")

    rc, links = run_repo(target, "links")
    links = links or {}
    if links.get("result") == "ok":
        out.extend(links.get("messages") or [])
    else:
        out.extend(links.get("messages") or [f"warn  条目↔提交索引未生成（exit {rc}）"])

    out.extend(enable_repo_integrations(target))
    return out, 0


# ---------------------------------------------------------------------------
# hooks / AGENTS
# ---------------------------------------------------------------------------

def _git_toplevel(target: Path) -> Path | None:
    try:
        r = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return Path(r.stdout.strip()).resolve()
    except OSError:
        return None


def install_hooks(target: Path) -> list[str]:
    out: list[str] = []
    hook_dir = target / "tools" / "git-hooks"
    out.append(copy_file(HERE / "templates" / "pre-commit", hook_dir / "pre-commit"))
    out.append(copy_file(HERE / "templates" / "commit-msg", hook_dir / "commit-msg"))

    top = _git_toplevel(target)
    if top is None:
        out.append(f"skip  {target} 不是 git 仓库，只装钩子文件")
        return out
    if top != target:
        out.append(f"warn  {target} 位于 git 仓库 {top} 内，只装钩子文件（不改父仓库 core.hooksPath）")
        return out
    try:
        subprocess.run(
            ["git", "-C", str(target), "config", "core.hooksPath", "tools/git-hooks"],
            check=True, capture_output=True, timeout=30,
        )
        out.append(f"git   core.hooksPath=tools/git-hooks ({target})")
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as e:
        out.append(f"warn  设置 core.hooksPath 失败：{e}")
    return out


def remove_plugin(target: Path) -> list[str]:
    plugin = target / PLUGIN_REL
    if not plugin.is_file():
        return [f"skip  {plugin}（未安装）"]
    try:
        plugin.unlink()
    except OSError as e:
        return [f"warn  删除插件失败：{e}"]
    out = [f"del   {plugin}（--remove-plugin）"]
    try:
        plugin.parent.rmdir()  # 只在目录为空时成功
        out.append(f"del   {plugin.parent}/（已空）")
    except OSError:
        pass
    return out


def append_agents_snippet(target: Path) -> str:
    agents = target / "AGENTS.md"
    snippet = (HERE / "templates" / "agents-snippet.md").read_text(encoding="utf-8")
    if agents.is_file():
        text = agents.read_text(encoding="utf-8")
        if MARKER in text:
            return f"skip  {agents}（已有安装标记）"
        sep = "" if text.endswith("\n") else "\n"
        agents.write_text(text + sep + "\n" + snippet, encoding="utf-8")
        return f"upd   {agents}（追加图谱/防漂移/仓库管理工作流片段）"
    agents.write_text(snippet, encoding="utf-8")
    return f"new   {agents}"


# ---------------------------------------------------------------------------
# 安装（可调用入口，供 CLI 与 MCP 共用）
# ---------------------------------------------------------------------------

def _summarize(logs: list[str]) -> dict:
    counts: dict[str, int] = {}
    for line in logs:
        key = line.strip().split(None, 1)[0] if line.strip() else ""
        if key:
            counts[key] = counts.get(key, 0) + 1
    counts["total"] = len(logs)
    return counts


def install_project(target: Path, opts: InstallOptions | None = None) -> dict:
    """把全家桶幂等安装进 target，返回机器可读报告（不打印）。"""
    target = Path(target).resolve()
    opts = opts or InstallOptions(target=target)
    opts.target = target

    if not target.is_dir():
        return {
            "ok": False,
            "target": str(target),
            "logs": [f"install: 目标不存在 {target}"],
            "summary": {},
            "options": _options_dict(opts),
        }

    logs: list[str] = []
    failed = False
    docs_info: dict = {
        "ready": False,
        "entryFiles": [],
        "missingEntryFiles": [],
        "invalidEntryFiles": [],
        "seedEntry": None,
        "seeded": False,
    }
    try:
        logs.append(copy_file(HERE / "tools" / "graphgen.py", target / "tools" / "graphgen.py"))
        logs.append(copy_file(
            HERE / "tools" / "graphgen.config.template.json",
            target / "tools" / "graphgen.config.template.json",
        ))
        logs.append(ensure_graphgen_config(target))
        if opts.remove_plugin:
            logs.extend(remove_plugin(target))
        if opts.plugin:
            logs.append(copy_file(HERE / "src" / "index.ts", target / PLUGIN_REL))
            logs.append(ensure_package_json(target))
        else:
            logs.append("skip  插件（MCP 模式默认不装；--plugin 安装文件监听插件）")
        skills_src = HERE / "skills" / "graphgen"
        if skills_src.is_dir():
            dst = target / ".opencode" / "skills" / "graphgen"
            if dst.is_dir():
                shutil.rmtree(dst)
            shutil.copytree(skills_src, dst)
            logs.append(f"copy  {dst}/（{len(list(dst.rglob('*')))} 项）")
        logs.append(copy_file(HERE / "tools" / "doclint.py", target / "tools" / "doclint.py"))
        logs.append(copy_file(HERE / "tools" / "gen_doc_slice.py", target / "tools" / "gen_doc_slice.py"))
        logs.append(ensure_doclint_config(target))
        logs.append(copy_file(HERE / "tools" / "repo.py", target / "tools" / "repo.py"))
        logs.append(copy_file(
            HERE / "tools" / "repo.config.template.json",
            target / "tools" / "repo.config.template.json",
        ))
        logs.append(ensure_repo_config(target))
        docs_logs, docs_info = ensure_docs_scaffold(target)
        logs.extend(docs_logs)
        vcs_logs, vcs_rc = ensure_vcs(target, opts)
        logs.extend(vcs_logs)
        if vcs_rc != 0:
            failed = True
        if opts.hooks:
            logs.extend(install_hooks(target))
        else:
            logs.append("skip  钩子（未加 --hooks）")
        if not opts.agents:
            logs.append("skip  AGENTS.md（--no-agents）")
        elif not docs_info.get("ready"):
            logs.append(
                "skip  AGENTS.md（entryFiles 未就绪；先补 docs/CHANGELOG.md，"
                "避免写入无法执行的工作流）"
            )
        else:
            logs.append(append_agents_snippet(target))
    except OSError as e:
        logs.append(f"install: 失败 {e}")
        failed = True

    return {
        "ok": not failed,
        "target": str(target),
        "logs": logs,
        "summary": _summarize(logs),
        "docs": docs_info,
        "options": _options_dict(opts),
    }


def _options_dict(opts: InstallOptions) -> dict:
    data = asdict(opts)
    data["target"] = str(opts.target)
    return data


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="opencode-graphgen 安装器")
    ap.add_argument("--target", required=True, help="目标项目根目录")
    ap.add_argument("--hooks", action="store_true", help="安装 pre-commit/commit-msg 钩子并启用 core.hooksPath")
    ap.add_argument("--no-agents", action="store_true", help="不创建/不追加目标 AGENTS.md（目标已有自己的工作流时用）")
    ap.add_argument("--vcs", default="auto", choices=["auto", "git", "hg", "svn", "none"],
                    help="代码仓库类型（auto=按 git>hg>svn 检测/建库；none=整步跳过）")
    ap.add_argument("--no-vcs-init", action="store_true", help="没有仓库时不自动建库（只检查并提示）")
    ap.add_argument("--vcs-remote", default="", help="建库时设置的远端地址（svn 必需）")
    ap.add_argument("--vcs-branch", default="", help="git 初始分支名（默认取配置 main）")
    ap.add_argument("--vcs-commit", action="store_true", help="建库后做首次提交（需已配置 git 身份）")
    ap.add_argument("--vcs-strict", action="store_true", help="缺少可用 VCS 工具时以非 0 退出")
    ap.add_argument("--no-snapshot", action="store_true", help="不生成部署快照/条目索引")
    ap.add_argument("--dry-run", action="store_true", help="只打印建库计划，不真正执行")
    ap.add_argument("--plugin", action="store_true",
                    help="同时安装文件监听插件（默认 MCP 模式不装；需要保存即重生成时用）")
    ap.add_argument("--remove-plugin", action="store_true", help="删除目标里已有的 graphgen-watch.ts（迁移到 MCP）")
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON（日志也放进 logs）")
    return ap


def main() -> int:
    args = build_parser().parse_args()
    target = Path(args.target).resolve()
    opts = InstallOptions(
        target=target,
        hooks=args.hooks,
        agents=not args.no_agents,
        vcs=args.vcs,
        vcs_init=not args.no_vcs_init,
        vcs_remote=args.vcs_remote,
        vcs_branch=args.vcs_branch,
        vcs_commit=args.vcs_commit,
        vcs_strict=args.vcs_strict,
        snapshot=not args.no_snapshot,
        dry_run=args.dry_run,
        plugin=args.plugin,
        remove_plugin=args.remove_plugin,
    )
    report = install_project(target, opts)

    if args.json:
        # 直接写 UTF-8 字节：MCP/Node 按 utf8 解码，不受 Windows 控制台代码页影响
        payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.flush()
        return 0 if report.get("ok") else 1

    print(f"install -> {report['target']}")
    for line in report.get("logs", []):
        print("  " + line)
    if not report.get("ok"):
        print("install: 失败（详情见上）")
        return 1
    print("install: OK（skill 若在 .opencode/skills 外还需手动放置；改完文档跑 "
          "python tools/graphgen.py 与 python tools/doclint.py 验证；"
          "仓库体检/快照见 python tools/repo.py status|snapshot）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
