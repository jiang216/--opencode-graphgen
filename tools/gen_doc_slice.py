#!/usr/bin/env python3
"""把 doc-slices.json + 事实源的生成结果写回文档 marker 块。

用法:
  python tools/gen_doc_slice.py --write   # 写回生成块
  python tools/gen_doc_slice.py --check   # 只校验（与 doclint 相同的 marker 检查）
  --config / --root 可指定配置与项目根（与 doclint 一致）

slice 类型（tools/doc-slices.json，每项）:
  menu     菜单树：source=<菜单 HTML>（解析 <dl>+data-title），可选 notes 覆盖组尾注
  filelist 文件清单：dir=<目录>，exts=[后缀]，sections=[{title, files:{文件: 用途}}]

marker 形式（手写内容勿改，改 tools/doc-slices.json / 事实源后 --write）:
  <!-- gen:name --> ... <!-- /gen:name -->
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import doclint  # noqa: E402  同目录模块


def main() -> int:
    ap = argparse.ArgumentParser(description="生成块写回工具")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--write", action="store_true", help="写回生成块")
    g.add_argument("--check", action="store_true", help="只校验（默认）")
    ap.add_argument("--config", help=f"配置路径（默认 {doclint.DEFAULT_CONFIG}）")
    ap.add_argument("--root", help="项目根（默认脚本所在 tools/ 的上级）")
    args = ap.parse_args()
    mode = "--write" if args.write else "--check"

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    cfg = doclint.load_config(root, args.config)
    ok, r = doclint.rule(cfg, "markers")
    if not ok:
        print("gen_doc_slice: markers 规则未启用（doclint 配置 rules.markers.enable）")
        return 2

    if mode == "--write":
        errs = doclint.write_markers(root, cfg)
    else:
        errs = doclint.check_markers(root, cfg)
    if errs:
        for e in errs:
            print(e)
        print(f"gen_doc_slice: {len(errs)} error(s)")
        return 1
    print("gen_doc_slice: OK" if mode == "--check" else "gen_doc_slice: write done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
