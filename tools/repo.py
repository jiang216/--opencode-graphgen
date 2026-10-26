#!/usr/bin/env python3
"""repo — 代码仓库适配层（git / hg / svn 统一，配置驱动，纯 stdlib）。

给 graphgen 全家桶补上「代码同步迭代」这一半能力：
  detect    检测仓库类型 / 仓库根 / 是否只是父仓库的子目录
  status    仓库体检（分支、HEAD、远端、工作区、上游 ahead/behind）
  init      建库（优先 git；svn 需要远端 URL，不在本地凭空造库）
  snapshot  生成部署侧快照 docs/repo.json + docs/REPO.md（AUTO-GENERATED）
  links     扫描提交，建立「文档条目 ↔ 提交」索引 docs/repo-links.json
  guard     提交 / 提交信息 / 推送前的只读护栏（不执行 add/commit/push）

配置：<项目>/tools/repo.config.json（缺省用内置默认值，字段见模板）
退出码：0=成功 1=失败的护栏/操作 2=用法错误 3=没有可用的 VCS 工具
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

DEFAULT_CONFIG = "tools/repo.config.json"
HERE = Path(__file__).resolve().parent

# 参与检测/建库的 VCS；顺序即默认优先级
VCS_ORDER = ("git", "hg", "svn")
VCS_MARKERS = {"git": ".git", "hg": ".hg", "svn": ".svn"}

DEFAULT_GITIGNORE = """# --- 由 opencode-graphgen 播种，可自由修改 ---
__pycache__/
*.py[cod]
.idea/
.DS_Store
Thumbs.db

# --- opencode-graphgen 部署快照（本地部署记录，不入库）---
docs/repo.json
docs/REPO.md
"""

IGNORE_MARKER = "# --- opencode-graphgen 部署快照（本地部署记录，不入库）---"
SNAPSHOT_IGNORES = ("docs/repo.json", "docs/REPO.md")

# 「UTF-8」「SHA-256」这类不是需求条目，做保守过滤
ID_DENYLIST = {
    "UTF", "SHA", "MD5", "ISO", "HTTP", "HTTPS", "GB", "MB", "KB", "TB",
    "H", "X", "Q", "V", "R", "T", "P", "N",
}

DEFAULTS: dict = {
    "vcs": {
        "priority": ["git", "hg", "svn"],
        "allowNested": False,
        "initBranch": "main",
        "remote": "",
        "commit": False,
        "strict": False,
        "commitMessage": "chore: 初始化仓库（opencode-graphgen）",
    },
    "snapshot": {
        "json": "docs/repo.json",
        "markdown": "docs/REPO.md",
    },
    "links": {
        "out": "docs/repo-links.json",
        "maxCommits": 300,
        "idPattern": "",
    },
    "guard": {
        "requireEntryId": False,
        "entryIdMode": "warn",
        "requireChangelogUpdate": True,
        "changelogMode": "warn",
        "docsPrefixes": ["docs/"],
        "docsFiles": ["AGENTS.md", "README.md"],
        "ignore": [
            "docs/graph.json", "docs/GRAPH.md", "docs/graph.mmd",
            "docs/repo.json", "docs/REPO.md", "docs/repo-links.json",
        ],
        "changelog": "docs/CHANGELOG.md",
        "maxFileMB": 50,
    },
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def to_posix(p: str | Path) -> str:
    return Path(p).as_posix()


def deep_merge(base: dict, override: dict) -> dict:
    out = json.loads(json.dumps(base))
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(root: Path) -> dict:
    path = root / DEFAULT_CONFIG
    if not path.is_file():
        return json.loads(json.dumps(DEFAULTS))
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"repo: 配置解析失败 {path}: {e}", file=sys.stderr)
        return json.loads(json.dumps(DEFAULTS))
    return deep_merge(DEFAULTS, data)


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> tuple[int, str, str]:
    """Run a command; never raise for missing binaries / timeouts."""
    kwargs: dict = {}
    if os.name == "nt":
        # 本机部分 Python 构建的 Popen 不认 windowsHide，改用 creationflags
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        r = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            **kwargs,
        )
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", f"命令不存在: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"命令超时: {' '.join(cmd[:3])}"
    except OSError as e:
        return 126, "", f"命令执行失败: {e}"


def has_tool(name: str) -> bool:
    return shutil.which(name) is not None


def tool_version(vcs: str) -> str:
    if not has_tool(vcs):
        return ""
    if vcs == "git":
        rc, out, _ = run(["git", "--version"])
        return out.replace("git version ", "").strip() if rc == 0 else ""
    if vcs == "hg":
        rc, out, _ = run(["hg", "--version"])
        return out.splitlines()[0].replace("Mercurial Distributed SCM (version ", "").rstrip(")") if rc == 0 else ""
    if vcs == "svn":
        rc, out, _ = run(["svn", "--version", "--quiet"])
        return out.strip() if rc == 0 else ""
    return ""


def git(root: Path, *args: str) -> tuple[int, str, str]:
    return run(["git", "-c", "core.quotepath=false", "-C", str(root), *args])


# ---------------------------------------------------------------------------
# detect
# ---------------------------------------------------------------------------

def detect(root: Path) -> dict:
    info: dict = {
        "root": to_posix(root),
        "vcs": "",
        "markers": [],
        "nested": False,
        "parentVcs": "",
        "parentRoot": None,
        "available": {v: has_tool(v) for v in VCS_ORDER},
    }
    present = [v for v in VCS_ORDER if (root / VCS_MARKERS[v]).exists()]
    if present:
        info["markers"] = present
        info["vcs"] = present[0]
        if len(present) > 1:
            info["conflict"] = present
        return info

    # 没有本地标记：判断是否只是父仓库的子目录（防止误建嵌套库）
    if has_tool("git"):
        rc, out, _ = git(root, "rev-parse", "--show-toplevel")
        if rc == 0 and out:
            top = Path(out.strip())
            try:
                top = top.resolve()
            except OSError:
                pass
            if top == root:
                info["vcs"] = "git"
                info["markers"] = ["git"]
                return info
            info.update(nested=True, parentVcs="git", parentRoot=to_posix(top))
            return info

    for vcs in ("hg", "svn"):
        cur = root
        for _ in range(24):
            if (cur / VCS_MARKERS[vcs]).exists():
                info.update(nested=True, parentVcs=vcs, parentRoot=to_posix(cur))
                return info
            if cur.parent == cur:
                break
            cur = cur.parent
    return info


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

def _git_status(root: Path) -> dict:
    out_info: dict = {
        "vcs": "git",
        "tool": tool_version("git"),
        "root": to_posix(root),
        "branch": "",
        "head": "",
        "headShort": "",
        "upstream": "",
        "ahead": None,
        "behind": None,
        "lastCommit": None,
        "remotes": [],
        "dirty": {"staged": 0, "modified": 0, "untracked": 0, "total": 0},
    }
    rc, out, err = git(root, "status", "--porcelain=v1", "-b", "--untracked-files=normal")
    if rc != 0:
        raise RuntimeError(err or "git status 失败")
    lines = out.splitlines()
    if lines and lines[0].startswith("## "):
        header = lines[0][3:].strip()
        lines = lines[1:]
        if header.startswith("No commits yet on "):
            out_info["branch"] = header[len("No commits yet on "):]
        elif header.startswith("HEAD (no branch)"):
            out_info["branch"] = "(detached)"
        else:
            left, _, right = header.partition("...")
            out_info["branch"] = left
            m = re.search(r"\[(.+?)\]", right)
            if m:
                flags = m.group(1)
                out_info["upstream"] = right.split(" ", 1)[0].strip()
                am = re.search(r"ahead (\d+)", flags)
                bm = re.search(r"behind (\d+)", flags)
                out_info["ahead"] = int(am.group(1)) if am else 0
                out_info["behind"] = int(bm.group(1)) if bm else 0
            elif right:
                out_info["upstream"] = right.strip()
    for line in lines:
        if len(line) < 2:
            continue
        x, y = line[0], line[1]
        if x == "?" and y == "?":
            out_info["dirty"]["untracked"] += 1
            continue
        if x not in " ?!":
            out_info["dirty"]["staged"] += 1
        if y not in " ?!":
            out_info["dirty"]["modified"] += 1
    d = out_info["dirty"]
    d["total"] = d["staged"] + d["modified"] + d["untracked"]

    rc, out, _ = git(root, "rev-parse", "--short", "HEAD")
    if rc == 0:
        out_info["headShort"] = out
    rc, out, _ = git(root, "rev-parse", "HEAD")
    if rc == 0:
        out_info["head"] = out

    rc, out, _ = git(root, "log", "-1", "--format=%H%x1f%aI%x1f%an%x1f%s")
    if rc == 0 and out:
        parts = (out.split("\x1f") + ["", "", "", ""])[:4]
        out_info["lastCommit"] = {
            "id": parts[0].strip(),
            "date": parts[1].strip(),
            "author": parts[2].strip(),
            "subject": parts[3].strip(),
        }

    rc, out, _ = git(root, "remote", "-v")
    if rc == 0 and out:
        seen: dict[str, str] = {}
        for line in out.splitlines():
            cols = line.split()
            if len(cols) >= 2 and cols[0] not in seen:
                seen[cols[0]] = cols[1]
        out_info["remotes"] = [{"name": k, "url": v} for k, v in seen.items()]
    return out_info


def _hg_status(root: Path) -> dict:
    out_info: dict = {
        "vcs": "hg",
        "tool": tool_version("hg"),
        "root": to_posix(root),
        "branch": "",
        "head": "",
        "headShort": "",
        "upstream": "",
        "ahead": None,
        "behind": None,
        "lastCommit": None,
        "remotes": [],
        "dirty": {"staged": 0, "modified": 0, "untracked": 0, "total": 0},
    }
    rc, out, _ = run(["hg", "--cwd", str(root), "branch"])
    if rc == 0:
        out_info["branch"] = out
    rc, out, _ = run(["hg", "--cwd", str(root), "id", "-i"])
    if rc == 0 and out:
        dirty = out.endswith("+")
        out_info["headShort"] = out.rstrip("+")
        out_info["head"] = out_info["headShort"]
        if dirty:
            out_info["dirty"]["modified"] = 1
    rc, out, _ = run(["hg", "--cwd", str(root), "log", "-r", ".", "-T",
                      "{node}\\x1f{date|isodate}\\x1f{author}\\x1f{desc|firstline}"])
    if rc == 0 and out:
        parts = (out.split("\x1f") + ["", "", "", ""])[:4]
        out_info["lastCommit"] = {
            "id": parts[0].strip(),
            "date": parts[1].strip(),
            "author": parts[2].strip(),
            "subject": parts[3].strip(),
        }
    rc, out, _ = run(["hg", "--cwd", str(root), "status"])
    if rc == 0 and out:
        for line in out.splitlines():
            if not line.strip():
                continue
            code = line[0]
            if code == "?":
                out_info["dirty"]["untracked"] += 1
            else:
                out_info["dirty"]["modified"] += 1
        d = out_info["dirty"]
        d["total"] = d["staged"] + d["modified"] + d["untracked"]
    rc, out, _ = run(["hg", "--cwd", str(root), "paths"])
    if rc == 0 and out:
        for line in out.splitlines():
            name, _, url = line.partition("=")
            name, url = name.strip(), url.strip()
            if name and url:
                out_info["remotes"].append({"name": name, "url": url})
                if name == "default" and not out_info["upstream"]:
                    out_info["upstream"] = "default"
    return out_info


def _svn_status(root: Path) -> dict:
    out_info: dict = {
        "vcs": "svn",
        "tool": tool_version("svn"),
        "root": to_posix(root),
        "branch": "",
        "head": "",
        "headShort": "",
        "upstream": "",
        "ahead": None,
        "behind": None,
        "lastCommit": None,
        "remotes": [],
        "dirty": {"staged": 0, "modified": 0, "untracked": 0, "total": 0},
    }
    rc, out, err = run(["svn", "info", "--xml", "--non-interactive", str(root)])
    if rc != 0:
        raise RuntimeError(err or "svn info 失败")
    try:
        entry = ET.fromstring(out).find("entry")
    except ET.ParseError as e:
        raise RuntimeError(f"svn info XML 解析失败: {e}")
    if entry is None:
        raise RuntimeError("svn info 未返回 entry")
    url = entry.findtext("url") or ""
    rel = entry.findtext("relative-url") or ""
    rev = entry.get("revision") or ""
    out_info["remotes"] = [{"name": "svn", "url": url}] if url else []
    out_info["branch"] = rel or url.rstrip("/").rsplit("/", 1)[-1]
    out_info["upstream"] = url
    out_info["head"] = f"r{rev}" if rev else ""
    out_info["headShort"] = out_info["head"]
    commit = entry.find("commit")
    if commit is not None:
        out_info["lastCommit"] = {
            "id": f"r{commit.get('revision', '')}",
            "date": (commit.findtext("date") or "").strip(),
            "author": (commit.findtext("author") or "").strip(),
            "subject": (commit.findtext("msg") or "").strip().splitlines()[0] if (commit.findtext("msg") or "").strip() else "",
        }
    rc, out, _ = run(["svn", "status", "--non-interactive", str(root)])
    if rc == 0 and out:
        for line in out.splitlines():
            if not line.strip():
                continue
            code = line[0]
            if code == "?":
                out_info["dirty"]["untracked"] += 1
            else:
                out_info["dirty"]["modified"] += 1
        d = out_info["dirty"]
        d["total"] = d["staged"] + d["modified"] + d["untracked"]
    return out_info


STATUS_FUNCS = {"git": _git_status, "hg": _hg_status, "svn": _svn_status}


def collect_status(root: Path, vcs: str) -> dict:
    return STATUS_FUNCS[vcs](root)


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------

def _install_hint(vcs: str) -> list[str]:
    return [
        f"warn  未检测到可用的 VCS 工具（git/svn/hg）{'' if vcs == 'auto' else f'，且 {vcs} 不可用'}",
        "warn  安装其一后重跑 install.py（本步可重复执行）：",
        "       Windows: winget install --id Git.Git -e   或   choco install git",
        "       macOS:   brew install git",
        "       Linux:   sudo apt install git   /   sudo dnf install git",
        "warn  已有仓库但工具缺失时，护栏与快照会自动跳过，不影响文档图谱。",
    ]


def _seed_gitignore(root: Path) -> str | None:
    gi = root / ".gitignore"
    if not gi.exists():
        gi.write_text(DEFAULT_GITIGNORE, encoding="utf-8")
        return to_posix(gi)
    return _append_snapshot_ignores(gi)


def _append_snapshot_ignores(gi: Path) -> str | None:
    """部署快照是本地部署记录：补 .gitignore，避免「提交后快照必然过期」的死循环。"""
    try:
        text = gi.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if IGNORE_MARKER in text:
        return None
    gi.write_text(
        text.rstrip("\n") + "\n\n" + IGNORE_MARKER + "\n" + "\n".join(SNAPSHOT_IGNORES) + "\n",
        encoding="utf-8",
    )
    return to_posix(gi)


def ensure_snapshot_gitignore(root: Path) -> str | None:
    gi = root / ".gitignore"
    if not gi.exists():
        gi.write_text(DEFAULT_GITIGNORE, encoding="utf-8")
        return to_posix(gi)
    return _append_snapshot_ignores(gi)


def _git_identity(root: Path) -> tuple[str, str]:
    _, name, _ = git(root, "config", "--get", "user.name")
    _, email, _ = git(root, "config", "--get", "user.email")
    return name.strip(), email.strip()


def _apply_git_identity(root: Path, name: str, email: str) -> str:
    """只写当前仓库 local 身份，绝不碰全局 git config。"""
    rc, _, err = git(root, "config", "--local", "user.name", name)
    if rc != 0:
        return f"warn  写入 local user.name 失败：{err}"
    rc, _, err = git(root, "config", "--local", "user.email", email)
    if rc != 0:
        return f"warn  写入 local user.email 失败：{err}"
    return f"git   local identity = {name} <{email}>（不写全局）"


def cmd_init(root: Path, cfg: dict, args: argparse.Namespace) -> tuple[int, dict]:
    info = detect(root)
    vcfg = cfg["vcs"]
    msgs: list[str] = []
    result: dict = {"action": "init", "result": "skip", "vcs": info["vcs"], "messages": msgs}

    if info["vcs"]:
        msgs.append(f"skip  已是 {info['vcs']} 仓库（{to_posix(root)}）")
        return 0, result
    if info["nested"] and not (vcfg.get("allowNested") or getattr(args, "allow_nested", False)):
        msgs.append(
            f"warn  目标位于 {info['parentVcs']} 仓库 {info['parentRoot']} 内，不建嵌套库"
            "（确需嵌套请加 --allow-nested）"
        )
        result["result"] = "nested"
        return 0, result

    choice = (args.vcs or "auto").lower()
    if choice == "auto":
        prio = [v for v in vcfg.get("priority", list(VCS_ORDER)) if v in VCS_ORDER]
        choice = next((v for v in prio if has_tool(v)), "")
        if not choice:
            msgs.extend(_install_hint("auto"))
            result["result"] = "no-tool"
            return (1 if vcfg.get("strict") else 0), result
    if not has_tool(choice):
        msgs.extend(_install_hint(choice))
        result["result"] = "no-tool"
        result["vcs"] = choice
        return (1 if vcfg.get("strict") else 0), result

    result["vcs"] = choice
    dry = bool(args.dry_run)
    msgs.append(f"{choice}   {'[dry-run] ' if dry else ''}准备在 {to_posix(root)} 建库")

    if choice == "git":
        branch = args.branch or vcfg.get("initBranch") or "main"
        if dry:
            msgs.append(f"git   [dry-run] git init -b {branch}")
        else:
            rc, out, err = git(root, "init", "-b", branch)
            if rc != 0:
                rc, out, err = git(root, "init")
                if rc != 0:
                    msgs.append(f"warn  git init 失败：{err or out}")
                    result["result"] = "failed"
                    return 1, result
                git(root, "symbolic-ref", "HEAD", f"refs/heads/{branch}")
            msgs.append(f"git   git init -b {branch}")
        git_name = (getattr(args, "git_name", "") or "").strip()
        git_email = (getattr(args, "git_email", "") or "").strip()
        if bool(git_name) != bool(git_email):
            msgs.append("warn  git-name/git-email 必须同时提供，已忽略身份写入")
        elif git_name and git_email:
            if dry:
                msgs.append(
                    f"git   [dry-run] local identity = {git_name} <{git_email}>"
                )
            else:
                msgs.append(_apply_git_identity(root, git_name, git_email))
        seeded = None if dry else _seed_gitignore(root)
        if seeded:
            msgs.append(f"git   .gitignore 就绪（{seeded}，含部署快照忽略项）")
        remote = args.remote or vcfg.get("remote") or ""
        if remote:
            if dry:
                msgs.append(f"git   [dry-run] git remote add origin {remote}")
            else:
                rc, out, err = git(root, "remote", "add", "origin", remote)
                if rc != 0:
                    msgs.append(f"warn  添加 remote 失败：{err or out}")
                else:
                    msgs.append(f"git   remote origin = {remote}")
        want_commit = bool(args.commit or vcfg.get("commit"))
        if want_commit:
            name, email = _git_identity(root)
            if not name or not email:
                msgs.append("warn  未配置 git 身份（user.name/user.email），跳过首次提交")
                msgs.append("       配置后可手动：git config user.name \"…\" && git config user.email \"…\"")
            elif dry:
                msgs.append("git   [dry-run] git add -A && git commit")
            else:
                rc, _, err = git(root, "add", "-A")
                if rc != 0:
                    msgs.append(f"warn  git add 失败：{err}")
                else:
                    rc, out, err = git(root, "commit", "-m", vcfg.get("commitMessage") or "chore: 初始化仓库")
                    if rc != 0:
                        msgs.append(f"warn  首次提交失败（可手动提交）：{err or out}")
                    else:
                        msgs.append("git   首次提交完成")
        result["result"] = "planned" if dry else "init"

    elif choice == "hg":
        if dry:
            msgs.append("hg    [dry-run] hg init")
        else:
            rc, out, err = run(["hg", "init", str(root)])
            if rc != 0:
                msgs.append(f"warn  hg init 失败：{err or out}")
                result["result"] = "failed"
                return 1, result
            msgs.append("hg    hg init")
        result["result"] = "planned" if dry else "init"

    elif choice == "svn":
        remote = args.remote or vcfg.get("remote") or ""
        if not remote:
            msgs.append("warn  svn 需要服务端仓库地址，未在本地凭空创建（避免造出无人可用的库）")
            msgs.append("       提供地址后重跑：install.py --vcs svn --vcs-remote <URL>")
            msgs.append("       或手动：svn checkout <URL> .")
            result["result"] = "needs-remote"
            return (1 if vcfg.get("strict") else 0), result
        entries = [p for p in root.iterdir() if p.name not in {".git", ".hg", ".svn"}]
        if entries:
            msgs.append(f"warn  目录非空（{len(entries)} 项），不自动 svn checkout，避免覆盖现有文件")
            msgs.append(f"       请手动：cd {to_posix(root)} && svn checkout {remote} .")
            result["result"] = "skip"
            return 0, result
        if dry:
            msgs.append(f"svn   [dry-run] svn checkout {remote} .")
        else:
            rc, out, err = run(["svn", "checkout", remote, "."], cwd=root)
            if rc != 0:
                msgs.append(f"warn  svn checkout 失败：{err or out}")
                result["result"] = "failed"
                return 1, result
            msgs.append(f"svn   svn checkout {remote}")
        result["result"] = "planned" if dry else "init"

    return 0, result


# ---------------------------------------------------------------------------
# snapshot
# ---------------------------------------------------------------------------

def _dirty_text(dirty: dict) -> str:
    if not dirty.get("total"):
        return "干净"
    return (
        f"{dirty['total']} 处改动"
        f"（暂存 {dirty['staged']} / 未暂存 {dirty['modified']} / 未跟踪 {dirty['untracked']}）"
    )


def _md_cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def build_snapshot(root: Path, cfg: dict) -> tuple[dict, str]:
    info = detect(root)
    if not info["vcs"]:
        raise RuntimeError("未检测到代码仓库，无法生成快照（先跑 repo.py init）")
    st = collect_status(root, info["vcs"])
    now = datetime.now().astimezone()

    snap = {
        "version": "1.0",
        "generatedAt": now.isoformat(timespec="seconds"),
        "vcs": st["vcs"],
        "tool": st.get("tool", ""),
        "root": st["root"],
        "branch": st.get("branch", ""),
        "head": st.get("head", ""),
        "headShort": st.get("headShort", ""),
        "upstream": st.get("upstream", ""),
        "ahead": st.get("ahead"),
        "behind": st.get("behind"),
        "remotes": st.get("remotes", []),
        "dirty": st.get("dirty", {}),
        "lastCommit": st.get("lastCommit"),
        "deploy": {
            "host": socket.gethostname(),
            "user": os.environ.get("USERNAME") or os.environ.get("USER") or "",
            "platform": f"{platform.system()} {platform.release()}",
            "python": platform.python_version(),
            "directory": to_posix(root),
        },
    }

    remote_txt = "<br>".join(f"{r['name']}: {r['url']}" for r in snap["remotes"]) or "（无）"
    last = snap["lastCommit"] or {}
    upstream = snap["upstream"] or "（无）"
    if snap["ahead"] is not None:
        upstream += f"（ahead {snap['ahead']} / behind {snap['behind']}）"

    L = [
        "# 代码仓库快照（AUTO-GENERATED）",
        "",
        "> 由 `python tools/repo.py snapshot` 生成，**请勿手改**；重新生成会覆盖本文件。",
        f"> 生成时间：{snap['generatedAt']}",
        "> 与当前仓库不一致时 `python tools/doclint.py` 的 R8 会报错。",
        "",
        "## 仓库",
        "",
        "| 项 | 值 |",
        "|----|----|",
        f"| VCS | {_md_cell(st['vcs'] + ' ' + str(snap['tool'])).strip()} |",
        f"| 仓库根 | `{_md_cell(snap['root'])}` |",
        f"| 分支 | {_md_cell(snap['branch'] or '（无）')} |",
        f"| HEAD | `{_md_cell(snap['headShort'] or '(空仓库)')}`"
        + (f"（`{snap['head']}`）" if snap["head"] and snap["head"] != snap["headShort"] else "")
        + " |",
        f"| 上游 | {_md_cell(upstream)} |",
        f"| 远端 | {_md_cell(remote_txt)} |",
        f"| 工作区 | {_md_cell(_dirty_text(snap['dirty']))} |",
        f"| 最后提交 | {_md_cell(last.get('date', '（无）'))}"
        f" · {_md_cell(last.get('author', ''))}"
        f" · {_md_cell(last.get('subject', ''))} |",
        "",
        "## 部署环境",
        "",
        "| 项 | 值 |",
        "|----|----|",
        f"| 主机 | `{_md_cell(snap['deploy']['host'])}` |",
        f"| 用户 | `{_md_cell(snap['deploy']['user'])}` |",
        f"| 平台 | {_md_cell(snap['deploy']['platform'])} / Python {snap['deploy']['python']} |",
        f"| 部署目录 | `{_md_cell(snap['deploy']['directory'])}` |",
        "",
    ]
    return snap, "\n".join(L)


def cmd_snapshot(root: Path, cfg: dict) -> tuple[int, dict]:
    paths = cfg["snapshot"]
    try:
        snap, md = build_snapshot(root, cfg)
    except RuntimeError as e:
        return 1, {"action": "snapshot", "result": "error", "messages": [f"warn  {e}"]}
    jp = root / paths["json"]
    mp = root / paths["markdown"]
    jp.parent.mkdir(parents=True, exist_ok=True)
    mp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text(json.dumps(snap, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    mp.write_text(md, encoding="utf-8")
    msgs = [
        f"snapshot  {snap['vcs']} {snap['branch'] or '(no branch)'} @ {snap['headShort'] or '(empty)'}",
        f"snapshot  写入 {to_posix(jp)} / {to_posix(mp)}",
    ]
    gi = ensure_snapshot_gitignore(root)
    if gi:
        msgs.append(f"repo   .gitignore 已补充部署快照忽略项（{gi}）")
    return 0, {
        "action": "snapshot",
        "result": "ok",
        "vcs": snap["vcs"],
        "head": snap["headShort"],
        "branch": snap["branch"],
        "json": to_posix(jp),
        "markdown": to_posix(mp),
        "messages": msgs,
    }


# ---------------------------------------------------------------------------
# links: 文档条目 ↔ 提交
# ---------------------------------------------------------------------------

def build_entry_regex(root: Path, cfg: dict) -> re.Pattern:
    pat = (cfg["links"].get("idPattern") or "").strip()
    if pat:
        return re.compile(pat)
    prefixes: list[str] = []
    gpath = root / "tools" / "graphgen.config.json"
    if gpath.is_file():
        try:
            g = json.loads(gpath.read_text(encoding="utf-8-sig"))
            prefixes = [
                p for p in (g.get("prefixes") or {})
                if isinstance(p, str) and re.fullmatch(r"[A-Z][A-Z0-9]*", p)
            ]
        except (OSError, json.JSONDecodeError):
            prefixes = []
    if prefixes:
        alt = "|".join(sorted((re.escape(p) for p in prefixes), key=len, reverse=True))
        return re.compile(rf"(?<![A-Za-z0-9])({alt})-(\d{{1,4}})(?!\d)")
    return re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,7})-(\d{1,4})(?!\d)")


def extract_ids(text: str, pattern: re.Pattern) -> list[str]:
    out: list[str] = []
    for m in pattern.finditer(text or ""):
        prefix = m.group(1)
        if prefix in ID_DENYLIST:
            continue
        eid = f"{prefix}-{m.group(2)}"
        if eid not in out:
            out.append(eid)
    return out


def _commits_git(root: Path, limit: int) -> list[dict]:
    rc, out, err = git(
        root, "log", "--no-merges", f"-n{limit}",
        "--pretty=format:%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e",
    )
    if rc != 0:
        raise RuntimeError(err or "git log 失败")
    commits: list[dict] = []
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        parts = rec.split("\x1f")
        if len(parts) < 4:
            continue
        commits.append({
            "id": parts[0].strip(),
            "date": parts[1].strip(),
            "author": parts[2].strip(),
            "subject": parts[3].strip(),
            "body": parts[4] if len(parts) > 4 else "",
        })
    return commits


def _commits_hg(root: Path, limit: int) -> list[dict]:
    tmpl = "{node}\\x1f{date|isodate}\\x1f{author}\\x1f{desc|firstline}\\x1f{desc}\\x1e"
    rc, out, err = run(["hg", "--cwd", str(root), "log", "-l", str(limit), "-T", tmpl])
    if rc != 0:
        raise RuntimeError(err or "hg log 失败")
    commits: list[dict] = []
    for rec in out.split("\x1e"):
        if not rec.strip():
            continue
        parts = rec.split("\x1f")
        if len(parts) < 4:
            continue
        commits.append({
            "id": parts[0].strip(),
            "date": parts[1].strip(),
            "author": parts[2].strip(),
            "subject": parts[3].strip(),
            "body": parts[4] if len(parts) > 4 else "",
        })
    return commits


def _commits_svn(root: Path, limit: int) -> list[dict]:
    rc, out, err = run(["svn", "log", "--xml", "--non-interactive", "-l", str(limit), str(root)])
    if rc != 0:
        raise RuntimeError(err or "svn log 失败")
    try:
        tree = ET.fromstring(out)
    except ET.ParseError as e:
        raise RuntimeError(f"svn log XML 解析失败: {e}")
    commits: list[dict] = []
    for e in tree.findall("logentry"):
        author = (e.findtext("author") or "").strip()
        msg = (e.findtext("msg") or "").strip()
        commits.append({
            "id": f"r{e.get('revision', '')}",
            "date": (e.findtext("date") or "").strip(),
            "author": author,
            "subject": msg.splitlines()[0] if msg else "",
            "body": msg,
        })
    return commits


def cmd_links(root: Path, cfg: dict, args: argparse.Namespace) -> tuple[int, dict]:
    info = detect(root)
    if not info["vcs"]:
        return 1, {"action": "links", "result": "error",
                   "messages": ["warn  未检测到代码仓库，无法建立条目↔提交索引"]}
    limit = int(args.max or cfg["links"].get("maxCommits") or 300)
    try:
        empty_repo = False
        if info["vcs"] == "git":
            rc, _, _ = git(root, "rev-parse", "HEAD")
            if rc != 0:
                commits, empty_repo = [], True
            else:
                commits = _commits_git(root, limit)
        elif info["vcs"] == "hg":
            commits = _commits_hg(root, limit)
        else:
            commits = _commits_svn(root, limit)
    except RuntimeError as e:
        return 1, {"action": "links", "result": "error", "messages": [f"warn  {e}"]}

    pattern = build_entry_regex(root, cfg)
    by_entry: dict[str, list[dict]] = {}
    rows: list[dict] = []
    for c in commits:
        ids = extract_ids(f"{c['subject']}\n{c['body']}", pattern)
        if not ids:
            continue
        short = (c["id"][:7] if info["vcs"] == "git" else c["id"])
        row = {"id": c["id"], "short": short, "date": c["date"],
               "author": c["author"], "subject": c["subject"], "entries": ids}
        rows.append(row)
        for eid in ids:
            by_entry.setdefault(eid, []).append(
                {"short": short, "date": c["date"], "subject": c["subject"]}
            )

    st = collect_status(root, info["vcs"])
    out = {
        "version": "1.0",
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "vcs": info["vcs"],
        "head": st.get("head", ""),
        "headShort": st.get("headShort", ""),
        "scanned": len(commits),
        "limit": limit,
        "matchedCommits": len(rows),
        "entries": len(by_entry),
        "commits": rows,
        "byEntry": by_entry,
    }
    path = root / cfg["links"].get("out", "docs/repo-links.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    msgs = []
    if rows:
        top = sorted(by_entry.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:8]
        brief = "，".join(f"{k}×{len(v)}" for k, v in top)
        msgs.append(f"links  扫描 {len(commits)} 提交 → {len(rows)} 条关联 / {len(by_entry)} 个条目（{brief}）")
    elif empty_repo:
        msgs.append("links  仓库尚无提交（首次提交后再跑 links 即可建立关联）")
    else:
        msgs.append(
            f"links  扫描 {len(commits)} 提交，未发现条目 ID（提交信息里写 DG-009 之类即可关联）"
        )
    msgs.append(f"links  写入 {to_posix(path)}")
    return 0, {
        "action": "links", "result": "ok", "vcs": info["vcs"],
        "scanned": len(commits), "matchedCommits": len(rows),
        "entries": len(by_entry), "out": to_posix(path),
        "byEntry": by_entry, "messages": msgs,
    }


# ---------------------------------------------------------------------------
# guard: 提交 / 提交信息 / 推送护栏
# ---------------------------------------------------------------------------

def _guard_commit(root: Path, cfg: dict) -> tuple[int, list[str], int, int]:
    g = cfg["guard"]
    msgs: list[str] = []
    errors = 0
    warnings = 0

    staged: list[str] = []
    if has_tool("git"):
        rc, out, _ = git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR")
        if rc == 0 and out:
            staged = [ln.strip() for ln in out.splitlines() if ln.strip()]
    if not staged:
        return 0, ["info   暂存区为空，跳过提交护栏"], 0, 0

    changelog = g.get("changelog") or ""
    docs_prefixes = tuple(g.get("docsPrefixes") or [])
    docs_files = set(g.get("docsFiles") or [])
    ignore_globs = tuple(g.get("ignore") or ())
    touched_docs = [
        p for p in staged
        if (p in docs_files or (docs_prefixes and p.startswith(docs_prefixes)))
        and not any(fnmatch.fnmatch(p, pat) for pat in ignore_globs)
    ]
    if touched_docs and changelog and changelog not in staged and g.get("requireChangelogUpdate", True):
        mode = (g.get("changelogMode") or "warn").lower()
        detail = "、".join(touched_docs[:3]) + ("…" if len(touched_docs) > 3 else "")
        text = f"{len(touched_docs)} 个文档改动（{detail}）但 {changelog} 未暂存"
        if mode == "error":
            errors += 1
            msgs.append(f"guard  ERROR {text}（同步 CHANGELOG 或 --no-verify）")
        else:
            warnings += 1
            msgs.append(f"guard  WARN {text}（若只是错字可忽略）")

    max_mb = float(g.get("maxFileMB") or 0)
    if max_mb > 0:
        big: list[str] = []
        for p in staged:
            fp = root / p
            try:
                if fp.is_file() and fp.stat().st_size > max_mb * 1024 * 1024:
                    big.append(f"{p}（{fp.stat().st_size / 1048576:.1f} MB）")
            except OSError:
                continue
        if big:
            warnings += 1
            msgs.append(f"guard  WARN 暂存了大文件：{'、'.join(big[:3])}；确认是否需要 LFS 或排除")
    return (1 if errors else 0), msgs, errors, warnings


def _guard_commit_msg(root: Path, cfg: dict, message_file: str) -> tuple[int, list[str], int, int]:
    g = cfg["guard"]
    try:
        text = Path(message_file).read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return 0, [f"info   读不到提交信息 {message_file}: {e}（跳过）"], 0, 0
    body = "\n".join(ln for ln in text.splitlines() if not ln.strip().startswith("#"))
    pattern = build_entry_regex(root, cfg)
    ids = extract_ids(body, pattern)
    if ids:
        return 0, [f"guard  提交信息含条目：{', '.join(ids)}"], 0, 0
    if not g.get("requireEntryId"):
        return 0, ["info   提交信息未含条目 ID（当前未启用强制）"], 0, 0
    if (g.get("entryIdMode") or "warn").lower() == "error":
        return 1, ["guard  ERROR 提交信息必须包含条目 ID（如 Refs: DG-009）"], 1, 0
    return 0, ["guard  WARN 提交信息未含条目 ID（建议加 Refs: DG-009）"], 0, 1


def _guard_push(root: Path, cfg: dict) -> tuple[int, list[str], int, int]:
    info = detect(root)
    if not info["vcs"]:
        return 0, ["info   非仓库，跳过推送护栏"], 0, 0
    st = collect_status(root, info["vcs"])
    msgs: list[str] = []
    warnings = 0
    if st["dirty"]["total"]:
        warnings += 1
        msgs.append(f"guard  WARN 工作区有 {st['dirty']['total']} 处未提交改动，推送前请确认")
    if st.get("behind"):
        warnings += 1
        msgs.append(f"guard  WARN 落后上游 {st['behind']} 个提交，先同步：git pull --ff-only")
    snap_path = root / cfg["snapshot"]["json"]
    if snap_path.is_file():
        try:
            snap = json.loads(snap_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            snap = {}
        if snap.get("head") and st.get("head") and snap["head"] != st["head"]:
            msgs.append("info   部署快照落后于当前 HEAD（发布前跑 repo.py snapshot）")
    return 0, msgs or ["guard  OK"], 0, warnings


def cmd_guard(root: Path, cfg: dict, args: argparse.Namespace) -> tuple[int, dict]:
    stage = args.stage
    if stage == "commit":
        rc, msgs, errs, warns = _guard_commit(root, cfg)
    elif stage == "commit-msg":
        if not args.message_file:
            return 2, {"action": "guard", "result": "error",
                       "messages": ["guard  ERROR --stage commit-msg 需要 --message-file"]}
        rc, msgs, errs, warns = _guard_commit_msg(root, cfg, args.message_file)
    elif stage == "push":
        rc, msgs, errs, warns = _guard_push(root, cfg)
    else:
        return 2, {"action": "guard", "result": "error",
                    "messages": [f"guard  ERROR 未知 stage: {stage}"]}
    if not msgs:
        msgs = ["guard  OK"]
    if errs == 0 and warns == 0 and msgs == ["guard  OK"]:
        msgs = ["guard  OK"]
    return rc, {
        "action": "guard", "stage": stage, "result": "ok" if rc == 0 else "error",
        "errors": errs, "warnings": warns, "messages": msgs,
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def _default_root() -> Path:
    return HERE.parent.resolve()


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    # 公共参数既能放在子命令前，也能放在子命令后（SUPPRESS 保证不覆盖父级默认值）
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=argparse.SUPPRESS, help="项目根（默认脚本所在 tools/ 的上级）")
    common.add_argument("--config", default=argparse.SUPPRESS, help=f"配置路径（默认 {DEFAULT_CONFIG}）")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="输出机器可读 JSON")

    ap = argparse.ArgumentParser(description="代码仓库适配层（git/hg/svn）")
    ap.add_argument("--root", default=None, help="项目根（默认脚本所在 tools/ 的上级）")
    ap.add_argument("--config", default=None, help=f"配置路径（默认 {DEFAULT_CONFIG}）")
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("detect", help="检测仓库类型/根/是否嵌套在父仓库", parents=[common])

    sub.add_parser("status", help="仓库体检", parents=[common])

    p_init = sub.add_parser("init", help="建库", parents=[common])
    p_init.add_argument("--vcs", choices=["auto", "git", "hg", "svn"], default="auto")
    p_init.add_argument("--remote", default="", help="远端地址（svn 必需）")
    p_init.add_argument("--branch", default="", help="初始分支名（git，默认 main）")
    p_init.add_argument("--git-name", default="", help="写入当前仓库 local user.name（不写全局）")
    p_init.add_argument("--git-email", default="", help="写入当前仓库 local user.email（不写全局）")
    p_init.add_argument("--commit", action="store_true", help="建库后做首次提交（需 git 身份）")
    p_init.add_argument("--allow-nested", action="store_true", help="允许在父仓库内建嵌套库")
    p_init.add_argument("--dry-run", action="store_true")

    sub.add_parser("snapshot", help="生成部署侧快照", parents=[common])

    p_links = sub.add_parser("links", help="建立条目↔提交索引", parents=[common])
    p_links.add_argument("--max", type=int, default=0, help="最多扫描的提交数（默认取配置）")

    p_guard = sub.add_parser("guard", help="提交/提交信息/推送护栏", parents=[common])
    p_guard.add_argument("--stage", required=True, choices=["commit", "commit-msg", "push"])
    p_guard.add_argument("--message-file", default="", help="commit-msg 阶段的提交信息文件")

    args = ap.parse_args(argv)
    root = Path(args.root).resolve() if args.root else _default_root()
    if not root.is_dir():
        print(f"repo: 目标不存在 {root}", file=sys.stderr)
        return 2

    cfg = load_config(root)
    if args.config:
        p = Path(args.config)
        p = p if p.is_absolute() else root / p
        try:
            cfg = deep_merge(DEFAULTS, json.loads(p.read_text(encoding="utf-8-sig")))
        except (OSError, json.JSONDecodeError) as e:
            print(f"repo: 配置读取失败 {p}: {e}", file=sys.stderr)
            return 2

    if args.cmd == "detect":
        result = {"action": "detect", **detect(root)}
        rc = 0
    elif args.cmd == "status":
        info = detect(root)
        if not info["vcs"]:
            result = {"action": "status", "result": "no-repo", "messages": ["warn  未检测到代码仓库"]}
            rc = 1
        else:
            try:
                result = {"action": "status", "result": "ok", **collect_status(root, info["vcs"])}
                rc = 0
            except RuntimeError as e:
                result = {"action": "status", "result": "error", "messages": [f"warn  {e}"]}
                rc = 1
    elif args.cmd == "init":
        rc, result = cmd_init(root, cfg, args)
    elif args.cmd == "snapshot":
        rc, result = cmd_snapshot(root, cfg)
    elif args.cmd == "links":
        rc, result = cmd_links(root, cfg, args)
    else:
        rc, result = cmd_guard(root, cfg, args)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        msgs = result.pop("messages", []) if isinstance(result, dict) else []
        for line in msgs:
            print(line)
        if args.cmd in ("detect", "status") and result.get("vcs"):
            if args.cmd == "detect":
                where = result.get("parentRoot") if result.get("nested") else result.get("root")
                print(f"{result['vcs']}   {result['root']}"
                      + (f"（父仓库 {where}）" if result.get("nested") else ""))
                if result.get("conflict"):
                    print(f"warn  同时存在多个 VCS 标记：{', '.join(result['conflict'])}"
                          f"（按优先级取 {result['vcs']}）")
            else:
                d = result.get("dirty", {})
                print(f"{result['vcs']}   {result.get('branch') or '(no branch)'} @ "
                      f"{result.get('headShort') or '(empty)'} · {_dirty_text(d)}")
                if result.get("remotes"):
                    print("      remote: " + "、".join(f"{r['name']}={r['url']}" for r in result["remotes"]))
    return rc


if __name__ == "__main__":
    sys.exit(main())
