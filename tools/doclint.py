#!/usr/bin/env python3
"""doclint — 文档漂移机械校验（配置驱动，纯 stdlib）。

规则（每条在 config 的 rules 里单独开关与配参）：
  R1 章节编号：roots 下 *.md 编号唯一、层级匹配、兄弟序号连续
  R2 菜单块：source(HTML) 的 <dl> 菜单 vs doc 文件的代码块（组 — 项/项 行）
  R3 清单：dir 目录文件 vs doc 文件反引号文件名（双向差集）
  R4 应用：appRoot 下含 controller/ 的目录 vs docs 各路由表的 `/xxx/`
  R5 白名单：gitignore 的 ! 例外文件必须存在
  R6 凭据：scan glob 内禁止密钥赋值/散列（可配 ban 黑名单）
  R7 变更日志：条目编号连续（按前缀）、日期（YYYY-MM-DD）、
     requireHistory 里 {前缀: 起始编号} 起必须含「相关历史条目」
  R8 部署快照：docs/repo.json 记录的 HEAD 必须等于当前 HEAD（防部署漂移；
     提交钩子里用 DOCLINT_SKIP_R8=1 跳过，因为提交本身会让快照变旧）
  markers：生成块 marker 内容 == 生成器输出（gen_doc_slice --write）

配置：默认读 <项目>/tools/doclint.config.json，可用 --config 指定。
退出码：0=通过 1=有错误 2=配置错误

用法：python tools/doclint.py [--config path]
"""
from __future__ import annotations

import argparse
import glob as globmod
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_CONFIG = "tools/doclint.config.json"


def rel(root: Path, p: Path) -> str:
    return p.relative_to(root).as_posix()


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def norm(s: str) -> str:
    lines = [ln.rstrip() for ln in s.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def load_config(root: Path, explicit: str | None) -> dict:
    path = Path(explicit) if explicit else root / DEFAULT_CONFIG
    if not path.is_absolute():
        path = root / path
    if not path.is_file():
        raise SystemExit(f"doclint: 找不到配置 {path}（先安装 install.py 或用 --config 指定）")
    try:
        return json.loads(read(path))
    except json.JSONDecodeError as e:
        raise SystemExit(f"doclint: 配置 JSON 解析失败 {path}: {e}")


def rule(cfg: dict, key: str) -> tuple[bool, dict]:
    r = cfg.get("rules", {}).get(key, {})
    return bool(r.get("enable")), r


# ---------------------------------------------------------------- R1
def check_heading_numbers(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R1")
    if not ok:
        return []
    errs: list[str] = []
    for base in r.get("roots", ["docs"]):
        for md in sorted((root / base).rglob("*.md")) if (root / base).is_dir() else []:
            seen: dict[str, int] = {}
            order: list[tuple[str, int, int]] = []
            in_fence = False
            for i, line in enumerate(read(md).splitlines(), 1):
                if re.match(r"^\s*(```|~~~)", line):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                m = re.match(r"^(#{2,4})\s+(\d+(?:\.\d+)*)(?:[\s.].*)?$", line)
                if not m:
                    continue
                level, num = len(m.group(1)), m.group(2)
                where = f"{rel(root, md)}:{i}"
                if num in seen:
                    errs.append(f"R1 {where} 重复编号 {num}（首见 {seen[num]} 行）")
                seen[num] = i
                order.append((num, level, i))
                expected_level = num.count(".") + 2
                if level != expected_level:
                    errs.append(
                        f"R1 {where} 编号 {num} 应为 {'#' * expected_level}，实为 {'#' * level}"
                    )
                if "." in num:
                    parent = num.rsplit(".", 1)[0]
                    if parent not in seen and parent not in {n for n, _, _ in order}:
                        errs.append(f"R1 {where} 编号 {num} 缺少上级标题 {parent}")
            groups: dict[str, list[tuple[str, int]]] = {}
            for num, _level, i in order:
                parent = num.rsplit(".", 1)[0] if "." in num else ""
                seq = num.rsplit(".", 1)[-1]
                groups.setdefault(parent, []).append((seq, i))
            for parent, items in groups.items():
                for expect, (seq, i) in enumerate(items, 1):
                    if int(seq) != expect:
                        label = f"{parent}.{seq}" if parent else seq
                        errs.append(
                            f"R1 {rel(root, md)}:{i} 编号 {label} 不连续（期望第 {expect} 个）"
                        )
                        break
    return errs


# ---------------------------------------------------------------- 菜单解析/生成
def parse_menu_source(root: Path, source: str) -> list[tuple[str, list[str]]]:
    """解析 Hui 风格菜单 HTML（<dl> 组 + data-title 项）→ [(组, [项...]), ...]。"""
    text = read(root / source)
    groups: list[tuple[str, list[str]]] = []
    for dl in re.finditer(r"<dl[^>]*>(.*?)</dl>", text, re.S):
        block = dl.group(1)
        dt = re.search(r"<dt[^>]*>(.*?)</dt>", block, re.S)
        if not dt:
            continue
        name = re.sub(r"<[^>]+>", "", dt.group(1))
        name = re.sub(r"&#x[0-9a-fA-F]+;", "", name)
        name = re.sub(r"&#\d+;", "", name).strip()
        items = re.findall(r'data-title="([^"]*)"', block)
        if name:
            groups.append((name, items))
    return groups


def load_slices(root: Path, cfg: dict) -> dict:
    ok, r = rule(cfg, "markers")
    if not ok:
        return {}
    path = root / r.get("slices", "tools/doc-slices.json")
    if not path.is_file():
        return {}
    return json.loads(read(path))


def build_slice(root: Path, name: str, scfg: dict) -> tuple[str, list[str]]:
    """按 slices 配置生成 marker 内容；返回 (content, errors)。"""
    errs: list[str] = []
    stype = scfg["type"]
    if stype == "menu":
        if "source" not in scfg:
            return "", [f"doc-slices.json[{name}] menu 类型缺 source"]
        notes = scfg.get("notes", {})
        lines = [
            f"{g} — {'/'.join(items)}{notes.get(g, '')}"
            for g, items in parse_menu_source(root, scfg["source"])
        ]
        if not lines:
            errs.append(f"markers {scfg['source']} 未解析出任何菜单组")
        return "```\n" + "\n".join(lines) + "\n```\n", errs

    if stype == "filelist":
        if "dir" not in scfg:
            return "", [f"doc-slices.json[{name}] filelist 类型缺 dir"]
        exts = tuple(scfg.get("exts", [".sql", ".php"]))
        registered: dict[str, str] = {}
        for sec in scfg["sections"]:
            for f, desc in sec["files"].items():
                if f in registered:
                    errs.append(f"markers doc-slices.json 重复登记 {f}")
                registered[f] = desc
        src_dir = root / scfg["dir"]
        actual = {
            p.name
            for p in src_dir.iterdir()
            if p.is_file() and p.suffix in exts
        } if src_dir.is_dir() else set()
        reg = set(registered)
        for f in sorted(actual - reg):
            errs.append(f"markers {scfg['dir']}/{f} 存在但未在 doc-slices.json 登记")
        for f in sorted(reg - actual):
            errs.append(f"markers doc-slices.json 登记了不存在的 {scfg['dir']}/{f}")
        blocks: list[str] = []
        total = 0
        for sec in scfg["sections"]:
            rows = "\n".join(f"| `{f}` | {d} |" for f, d in sec["files"].items())
            total += len(sec["files"])
            blocks.append(
                f"### {sec['title']}\n\n| 文件 | 用途 |\n|------|------|\n{rows}"
            )
        header = scfg.get(
            "header",
            f"共 {total} 个文件（按 `{scfg['dir']}` 目录实际清单生成；新增脚本先在 "
            "slices 配置登记，再运行 `python tools/gen_doc_slice.py --write`，勿手改本块）",
        )
        header = header.replace("{total}", str(total))
        return header + "\n\n" + "\n\n".join(blocks) + "\n", errs

    errs.append(f"doc-slices.json 未知类型 {stype}（{name}）")
    return "", errs


# ---------------------------------------------------------------- markers
def check_markers(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "markers")
    if not ok:
        return []
    errs: list[str] = []
    slices_path = root / r.get("slices", "tools/doc-slices.json")
    if not slices_path.is_file():
        return []
    for name, scfg in json.loads(read(slices_path)).items():
        path = root / scfg["file"]
        if not path.is_file():
            errs.append(f"markers 文件不存在 {scfg['file']}（{name}）")
            continue
        text = read(path)
        m = re.search(
            rf"<!-- gen:{re.escape(name)} -->(.*?)<!-- /gen:{re.escape(name)} -->",
            text,
            re.S,
        )
        if not m:
            errs.append(f"markers {rel(root, path)} 缺少 <!-- gen:{name} --> 块")
            continue
        want, berrs = build_slice(root, name, scfg)
        errs.extend(berrs)
        if norm(m.group(1)) != norm(want):
            errs.append(
                f"生成块不一致 {rel(root, path)} [{name}] → "
                "python tools/gen_doc_slice.py --write"
            )
    return errs


def write_markers(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "markers")
    if not ok:
        return ["markers 规则未启用"]
    errs: list[str] = []
    slices_path = root / r.get("slices", "tools/doc-slices.json")
    if not slices_path.is_file():
        return [f"找不到 {rel(root, slices_path)}"]
    for name, scfg in json.loads(read(slices_path)).items():
        path = root / scfg["file"]
        text = read(path)
        pat = re.compile(
            rf"(<!-- gen:{re.escape(name)} -->)(.*?)(<!-- /gen:{re.escape(name)} -->)",
            re.S,
        )
        m = pat.search(text)
        if not m:
            errs.append(f"markers {rel(root, path)} 缺少 <!-- gen:{name} --> 块，先手动插入")
            continue
        want, berrs = build_slice(root, name, scfg)
        errs.extend(berrs)
        if berrs:
            continue
        new_text = text[: m.start(2)] + "\n" + want + text[m.end(2) :]
        if new_text != text:
            path.write_text(new_text, encoding="utf-8", newline="\n")
            print(f"written: {rel(root, path)} [{name}]")
    return errs


# ---------------------------------------------------------------- R2
def check_menu_block(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R2")
    if not ok:
        return []
    if "source" not in r or "doc" not in r:
        return ["R2 配置缺 source/doc"]
    errs: list[str] = []
    doc = root / r["doc"]
    if not doc.is_file():
        return [f"R2 文件不存在 {r['doc']}"]
    text = read(doc)
    heading = r.get("heading", "## 后台菜单结构")
    sec = re.search(re.escape(heading) + r"(.*?)(?=\n## |\Z)", text, re.S)
    if not sec:
        return [f"R2 {rel(root, doc)} 缺少「{heading}」小节"]
    fence = re.search(r"```[^\n]*\n(.*?)```", sec.group(1), re.S)
    if not fence:
        return [f"R2 {rel(root, doc)} 菜单小节内没有代码块"]
    doc_groups: list[tuple[str, list[str]]] = []
    for line in fence.group(1).splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^(\S+)\s+—\s+(.+)$", line)
        if not m:
            errs.append(f"R2 {rel(root, doc)} 菜单行无法解析: {line[:40]}")
            continue
        right = re.sub(r"（[^（）]*）", "", m.group(2))
        doc_groups.append((m.group(1), [x.strip() for x in right.split("/")]))
    src_groups = parse_menu_source(root, r["source"])
    src_names = [g for g, _ in src_groups]
    doc_names = [g for g, _ in doc_groups]
    for g in [x for x in src_names if x not in doc_names]:
        errs.append(f"R2 {rel(root, doc)} 缺少菜单组「{g}」")
    for g in [x for x in doc_names if x not in src_names]:
        errs.append(f"R2 {rel(root, doc)} 多出菜单组「{g}」（{r['source']} 中不存在）")
    if doc_names != src_names and not (set(doc_names) ^ set(src_names)):
        errs.append(f"R2 {rel(root, doc)} 菜单组顺序与 {r['source']} 不一致")
    src_map = dict(src_groups)
    for g, items in doc_groups:
        if g not in src_map:
            continue
        if items != src_map[g]:
            missing = [x for x in src_map[g] if x not in items]
            extra = [x for x in items if x not in src_map[g]]
            detail = "; ".join(
                x
                for x in [
                    ("缺少 " + ",".join(missing)) if missing else "",
                    ("多出 " + ",".join(extra)) if extra else "",
                    "顺序不同" if not missing and not extra else "",
                ]
                if x
            )
            errs.append(f"R2 {rel(root, doc)} 组「{g}」与菜单源不一致: {detail}")
    return errs


# ---------------------------------------------------------------- R3
def check_manifest(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R3")
    if not ok:
        return []
    if "dir" not in r or "doc" not in r:
        return ["R3 配置缺 dir/doc"]
    doc = root / r["doc"]
    if not doc.is_file():
        return [f"R3 文件不存在 {r['doc']}"]
    exts = r.get("exts", ["sql", "php"])
    ext_alt = "|".join(re.escape(e.lstrip(".")) for e in exts)
    tokens = set(re.findall(r"`([A-Za-z0-9_\-]+\.(?:%s))`" % ext_alt, read(doc)))
    src_dir = root / r["dir"]
    actual = {
        p.name
        for p in src_dir.iterdir()
        if p.is_file() and p.suffix.lstrip(".") in {e.lstrip(".") for e in exts}
    } if src_dir.is_dir() else set()
    errs = []
    for f in sorted(actual - tokens):
        errs.append(f"R3 {r['dir']}/{f} 存在但 {r['doc']} 未列出")
    for f in sorted(tokens - actual):
        errs.append(f"R3 {r['doc']} 列出了不存在的 {r['dir']}/{f}")
    return errs


# ---------------------------------------------------------------- R4
def check_http_apps(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R4")
    if not ok:
        return []
    app_root = root / r.get("appRoot", "app")
    if not app_root.is_dir():
        return [f"R4 应用目录不存在 {r.get('appRoot', 'app')}"]
    apps = sorted(
        p.name for p in app_root.iterdir() if p.is_dir() and (p / "controller").is_dir()
    )
    errs = []
    for doc_rel in r.get("docs", []):
        doc = root / doc_rel
        if not doc.is_file():
            errs.append(f"R4 文件不存在 {doc_rel}")
            continue
        text = read(doc)
        for app in apps:
            if f"`/{app}/`" in text:
                continue
            if app == r.get("rootApp", "index") and "`/`" in text:
                continue
            errs.append(f"R4 {doc_rel} 路由表缺少 HTTP 应用 /{app}/")
    return errs


# ---------------------------------------------------------------- R5
def check_whitelist(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R5")
    if not ok:
        return []
    gi_rel = r.get("gitignore", "public/static/.gitignore")
    gi = root / gi_rel
    if not gi.is_file():
        return [f"R5 找不到 {gi_rel}"]
    base = gi.parent
    errs = []
    for line in read(gi).splitlines():
        s = line.strip()
        if not s.startswith("!"):
            continue
        if not (base / s[1:]).exists():
            errs.append(
                f"R5 {gi_rel} 例外 {s[1:]} 指向的文件不存在"
                "（删除白名单文件需同步删除例外行）"
            )
    return errs


# ---------------------------------------------------------------- R6
_PLACEHOLDER = re.compile(
    r"(?i)(your[_-]|example|placeholder|change[_-]?me|xxxx|<[a-z]|\{[a-z_]|^\$\{|\.\.\.|^%|^\.\.)"
)
_ASSIGN = re.compile(
    r"(?i)\b([A-Za-z][A-Za-z0-9_]*(?:_key|_secret|_token|_password|_passwd|password|secret))\b"
    r"(?:\s*=>\s*|\s*=\s*|:\s*)[\"']?([^\s\"'`;:=(),]{6,})"
)
_BARE_MD5 = re.compile(r"(?<![0-9a-zA-Z])[0-9a-f]{32}(?![0-9a-zA-Z])")


def check_credentials(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R6")
    if not ok:
        return []
    paths: list[Path] = []
    for pattern in r.get("scan", ["AGENTS.md", "docs/**/*.md"]):
        if any(ch in pattern for ch in "*?["):
            paths.extend(Path(p) for p in globmod.glob(str(root / pattern), recursive=True))
        else:
            p = root / pattern
            if p.is_file():
                paths.append(p)
    ban = r.get("ban", [])
    errs = []
    for path in sorted(set(paths)):
        if not path.is_file():
            continue
        text = read(path)
        where = rel(root, path)
        for banned in ban:
            if banned in text:
                errs.append(f"R6 {where} 命中黑名单字面量「{banned}」（真实值只放 .env）")
        for i, line in enumerate(text.splitlines(), 1):
            flagged = False
            for key in r.get("sensitiveKeys", ["goods_content_key"]):
                if key.lower() in line.lower() and re.search(
                    rf"(?i){re.escape(key)}\s*[:=]\s*\S", line
                ):
                    if not re.search(rf"(?i){re.escape(key)}\s*[:=]\s*['\"]\s*['\"]\s*$", line):
                        errs.append(f"R6 {where}:{i} {key} 不得写入文档")
                        flagged = True
            m = _ASSIGN.search(line)
            if m and not flagged:
                k, v = m.group(1), m.group(2)
                if not (_PLACEHOLDER.search(v) or _PLACEHOLDER.search(k)):
                    errs.append(
                        f"R6 {where}:{i} 疑似密钥赋值 {k}=…（真实值只放 .env）"
                    )
            if _BARE_MD5.search(line):
                errs.append(f"R6 {where}:{i} 疑似 32 位十六进制密文/散列")
    return errs


# ---------------------------------------------------------------- R7
def check_changelog(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R7")
    if not ok:
        return []
    doc_rel = r.get("file", "docs/CHANGELOG.md")
    doc = root / doc_rel
    if not doc.is_file():
        return [f"R7 文件不存在 {doc_rel}"]
    text = read(doc)
    id_re = r.get("idPattern", r"^## ([A-Z]+)-(\d+):")
    heads = list(re.finditer(id_re, text, re.M))
    if not heads:
        return [f"R7 {doc_rel} 未匹配到任何条目（idPattern: {id_re}）"]
    errs: list[str] = []
    per_prefix: dict[str, list[int]] = {}
    for idx, m in enumerate(heads):
        prefix, num_s = m.group(1), m.group(2)
        num = int(num_s)
        per_prefix.setdefault(prefix, []).append(num)
        where = f"{doc_rel}:{text[: m.start()].count(chr(10)) + 1}"
        line_end = text.find("\n", m.start())
        tail = text[m.start(): line_end if line_end != -1 else len(text)]
        dm = re.search(r"（(\d{4}-\d{2}-\d{2})）\s*$", tail)
        if r.get("requireDate", True):
            if not dm:
                errs.append(f"R7 {where} 条目标题缺少（YYYY-MM-DD）日期")
            else:
                try:
                    datetime.strptime(dm.group(1), "%Y-%m-%d")
                except ValueError:
                    errs.append(f"R7 {where} 日期非法 {dm.group(1)}")
        body = text[
            m.end() : heads[idx + 1].start() if idx + 1 < len(heads) else len(text)
        ]
        min_hist = r.get("requireHistory", {}).get(prefix)
        if min_hist is not None and num >= min_hist:
            # 结构性标记才算块：行首「## 相关历史条目」H2（条目后独立节）或
            # 行首「**相关历史条目**」粗体（条目内联块）；正文散文明谈不计
            has_hist = re.search(
                r"(?m)^\s{0,3}#{1,6}\s+.*相关历史条目|^\s{0,3}\**相关历史条目\**",
                body,
            )
            if not has_hist:
                errs.append(
                    f"R7 {where} {prefix}-{num:03d} 起条目必须含「相关历史条目」块"
                )
    if r.get("checkSequence", True):
        allow_missing = {
            p: set(v) for p, v in r.get("allowMissing", {}).items()
        }
        for prefix, ids in per_prefix.items():
            dup = {i for i in ids if ids.count(i) > 1}
            for d in sorted(dup):
                errs.append(f"R7 {doc_rel} 重复条目 {prefix}-{d:03d}")
            hi = max(ids)
            missing = [
                n
                for n in range(hi, 0, -1)
                if n not in set(ids) and n not in allow_missing.get(prefix, set())
            ]
            if missing:
                errs.append(
                    f"R7 {doc_rel} {prefix} 编号不连续，缺 "
                    + ", ".join(f"{prefix}-{n:03d}" for n in missing)
                )
    return errs


# ---------------------------------------------------------------- R8
def _vcs_head(root: Path) -> str:
    """当前 HEAD（短）。优先调用 tools/repo.py，git/hg/svn 一套逻辑。"""
    repo_py = root / "tools" / "repo.py"
    if not repo_py.is_file():
        return ""
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        r = subprocess.run(
            [sys.executable, str(repo_py), "status", "--root", str(root), "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=60, **kwargs,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if r.returncode != 0:
        return ""
    try:
        return str((json.loads(r.stdout) or {}).get("headShort") or "")
    except json.JSONDecodeError:
        return ""


def check_repo_snapshot(root: Path, cfg: dict) -> list[str]:
    ok, r = rule(cfg, "R8")
    if not ok:
        return []
    # 快照记录的是「生成那一刻的 HEAD」，提交本身必然让它变旧：
    # 所以 R8 是发布/部署/CI 的检查项，提交钩子里用 DOCLINT_SKIP_R8=1 跳过。
    if os.environ.get("DOCLINT_SKIP_R8", "").strip().lower() in ("1", "true", "yes", "on"):
        return []
    snap_json = r.get("json", "docs/repo.json")
    snap_md = r.get("snapshot", "docs/REPO.md")
    jp = root / snap_json
    if not jp.is_file():
        return [f"R8 缺少部署快照 {snap_json}（先运行 python tools/repo.py snapshot）"]
    try:
        snap = json.loads(read(jp))
    except (OSError, json.JSONDecodeError) as e:
        return [f"R8 快照解析失败 {snap_json}: {e}"]
    head = _vcs_head(root)
    if not head:
        return []  # 没有仓库 / 没有可用 VCS：不误报
    recorded = str(snap.get("headShort") or snap.get("head") or "")
    errs: list[str] = []
    if recorded != head:
        errs.append(
            f"R8 部署快照过期：{snap_json} 记录 {recorded or '(空)'}，当前 HEAD {head}"
            "（重跑 python tools/repo.py snapshot）"
        )
    md = root / snap_md
    if not md.is_file():
        errs.append(f"R8 缺少人读快照 {snap_md}（重跑 python tools/repo.py snapshot）")
    elif recorded and recorded not in read(md):
        errs.append(f"R8 {snap_md} 与 {snap_json} 不一致（重跑 python tools/repo.py snapshot）")
    return errs


# ---------------------------------------------------------------- main
def run(root: Path, cfg: dict) -> list[str]:
    errs: list[str] = []
    errs += check_heading_numbers(root, cfg)
    errs += check_menu_block(root, cfg)
    errs += check_manifest(root, cfg)
    errs += check_http_apps(root, cfg)
    errs += check_whitelist(root, cfg)
    errs += check_credentials(root, cfg)
    errs += check_changelog(root, cfg)
    errs += check_repo_snapshot(root, cfg)
    errs += check_markers(root, cfg)
    return list(dict.fromkeys(errs))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="文档漂移机械校验")
    ap.add_argument("--config", help=f"配置路径（默认 {DEFAULT_CONFIG}）")
    ap.add_argument("--root", help="项目根（默认脚本所在 tools/ 的上级）")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    cfg = load_config(root, args.config)
    errs = run(root, cfg)
    for e in errs:
        print(e)
    if errs:
        print(f"doclint: {len(errs)} error(s)")
        return 1
    print("doclint: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
