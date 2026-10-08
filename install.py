#!/usr/bin/env python3
"""opencode-graphgen 统一安装器 — 把全家桶幂等装进目标项目。

用法:
  python install.py --target F:\\path\\to\\project [--hooks]

做什么（重复执行安全，已存在即覆盖=同步更新）:
  1. tools/graphgen.py、tools/graphgen.config.template.json  → <target>/tools/
     <target>/tools/graphgen.config.json 不存在时由模板生成（name=目录名）
  2. src/index.ts（插件）                                     → <target>/.opencode/plugins/graphgen-watch.ts
  3. skills/graphgen/                                        → <target>/.opencode/skills/graphgen/
  4. tools/doclint.py、tools/gen_doc_slice.py                → <target>/tools/
  5. tools/doclint.config.json 不存在时由 templates/doclint.config.example.json 生成
  6. <target>/.opencode/package.json 保证依赖 @opencode-ai/plugin（缺则建/补）
  7. --hooks: templates/pre-commit → <target>/tools/git-hooks/pre-commit
              且 target 是 git 仓库时设 core.hooksPath=tools/git-hooks
  8. AGENTS.md 追加模板片段（已有 <!-- graphgen:installed --> 标记则跳过）

退出码：0=成功 1=失败
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

PLUGIN_DEP = {"@opencode-ai/plugin": "1.18.7"}
MARKER = "<!-- graphgen:installed -->"


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


def ensure_doclint_config(target: Path) -> str:
    cfg = target / "tools" / "doclint.config.json"
    if cfg.is_file():
        return f"skip  {cfg}（已存在）"
    src = HERE / "templates" / "doclint.config.example.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, cfg)
    return f"new   {cfg}（示例配置，按项目裁剪规则开关/配参）"


def ensure_package_json(target: Path) -> str:
    pkg = target / ".opencode" / "package.json"
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
    if changed:
        pkg.parent.mkdir(parents=True, exist_ok=True)
        pkg.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return f"{'new ' if not pkg.is_file() else 'upd '} {pkg}"
    return f"skip  {pkg}（依赖已在）"


def install_hooks(target: Path) -> list[str]:
    out: list[str] = []
    hook_dst = target / "tools" / "git-hooks" / "pre-commit"
    out.append(copy_file(HERE / "templates" / "pre-commit", hook_dst))
    try:
        r = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode == 0 and r.stdout.strip() == "true":
            subprocess.run(
                ["git", "-C", str(target), "config", "core.hooksPath", "tools/git-hooks"],
                check=True, capture_output=True, timeout=30,
            )
            out.append(f"git   core.hooksPath=tools/git-hooks ({target})")
        else:
            out.append(f"skip  {target} 非 git 仓库，只装钩子文件")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        out.append(f"warn  git 不可用：{e}")
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
        return f"upd   {agents}（追加图谱/防漂移工作流片段）"
    agents.write_text(snippet, encoding="utf-8")
    return f"new   {agents}"


def main() -> int:
    ap = argparse.ArgumentParser(description="opencode-graphgen 安装器")
    ap.add_argument("--target", required=True, help="目标项目根目录")
    ap.add_argument("--hooks", action="store_true", help="安装 pre-commit 钩子并启用 core.hooksPath")
    ap.add_argument("--no-agents", action="store_true", help="不创建/不追加目标 AGENTS.md（目标已有自己的工作流时用）")
    args = ap.parse_args()

    target = Path(args.target).resolve()
    if not target.is_dir():
        print(f"install: 目标不存在 {target}")
        return 1

    logs: list[str] = []
    try:
        logs.append(copy_file(HERE / "tools" / "graphgen.py", target / "tools" / "graphgen.py"))
        logs.append(copy_file(
            HERE / "tools" / "graphgen.config.template.json",
            target / "tools" / "graphgen.config.template.json",
        ))
        logs.append(ensure_graphgen_config(target))
        logs.append(copy_file(HERE / "src" / "index.ts", target / ".opencode" / "plugins" / "graphgen-watch.ts"))
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
        logs.append(ensure_package_json(target))
        if args.hooks:
            logs.extend(install_hooks(target))
        else:
            logs.append("skip  钩子（未加 --hooks）")
        if args.no_agents:
            logs.append("skip  AGENTS.md（--no-agents）")
        else:
            logs.append(append_agents_snippet(target))
    except OSError as e:
        print(f"install: 失败 {e}")
        return 1

    print(f"install -> {target}")
    for line in logs:
        print("  " + line)
    print("install: OK（skill 若在 .opencode/skills 外还需手动放置；改完文档跑 "
          "python tools/graphgen.py 与 python tools/doclint.py 验证）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
