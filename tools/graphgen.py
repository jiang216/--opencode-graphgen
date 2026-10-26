#!/usr/bin/env python3
"""graphgen - generic markdown knowledge-graph generator & linter.

Parses a set of markdown docs (+ config-driven tables) into a node/edge
graph, computes Obsidian-style backlinks, emits graph.json / GRAPH.md /
graph.mmd, and lints for broken links, duplicate/unknown entry IDs,
referenced-but-missing entries and orphan entries.

Standalone, stdlib only. Project-specific conventions live in a JSON config
(see graphgen.config.json). Consumers are humans, agents and LLM models:
  - docs/graph.json : canonical data; every node carries `backlinks`
  - docs/GRAPH.md   : human/model readable index (auto-generated)
  - docs/graph.mmd  : Mermaid graph

Usage:
  python tools/graphgen.py            # generate all outputs
  python tools/graphgen.py --check    # lint only; exit=1 on errors (CI gate)
  python tools/graphgen.py --root DIR # scan/output relative to DIR (sandbox)
  python tools/graphgen.py --config F # alternative config path
  python tools/graphgen.py --init DIR # scaffold graphgen into another project
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

DEFAULT_CONFIG = "tools/graphgen.config.json"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def to_posix(p: str | Path) -> str:
    return Path(p).as_posix()


def github_anchor(text: str) -> str:
    """Reproduce GitHub-style markdown heading anchors.

    Lowercase, keep letters/numbers/hyphens, turn whitespace into '-',
    drop everything else (CJK full-width brackets included).
    """
    out: list[str] = []
    for ch in text.lower():
        if ch.isalnum() or ch == "-":
            out.append(ch)
        elif ch.isspace():
            out.append("-")
    return "".join(out)


def split_doc_names(text: str) -> list[str]:
    """Extract `.md` file names from a cell like 'renderer.md、gizmo.md、camera.md'
    or 'build.md（构建命令见本文件上方）'."""
    return re.findall(r"[A-Za-z0-9_.\-]+\.md", text)


# ---------------------------------------------------------------------------
# markdown scanner
# ---------------------------------------------------------------------------

@dataclass
class Link:
    label: str
    target: str
    section: str
    line: int


@dataclass
class Heading:
    level: int
    text: str
    anchor: str
    line: int


@dataclass
class Table:
    headers: list[str]
    rows: list[list[str]]
    section: str
    line: int


@dataclass
class ParsedFile:
    path: str
    frontmatter: dict[str, str] = field(default_factory=dict)
    headings: list[Heading] = field(default_factory=list)
    links: list[Link] = field(default_factory=list)
    backticks: list[str] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---")
    if end == -1:
        return {}, text
    fm: dict[str, str] = {}
    for line in text[3:end].splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm, text[end + 4 :]


LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)(?:\s+['\"][^'\"]*['\"])?\)")
BACKTICK_RE = re.compile(r"`([^`]+)`")


def code_free_segments(line: str):
    """Yield the portions of a line that are outside backtick code spans."""
    for idx, seg in enumerate(line.split("`")):
        if idx % 2 == 0 and seg:
            yield seg


def parse_file(path: str, text: str, ref_markers: list[str] | None = None) -> ParsedFile:
    fm, body = parse_frontmatter(text)
    pf = ParsedFile(path=path, frontmatter=fm)

    _collect_tables(pf, body)
    table_lines: set[int] = set()
    for t in pf.tables:
        table_lines.update(range(t.line, t.line + 2 + len(t.rows)))

    ref_re = None
    if ref_markers:
        ref_re = re.compile(r"^\s*(?:[*-]\s*)*\**(" + "|".join(re.escape(k) for k in ref_markers) + r")")

    lines = body.splitlines()
    in_code = False
    section = ""
    for i, raw in enumerate(lines, start=1):
        if i in table_lines:
            continue
        line = raw.strip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code or not line:
            continue

        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            h = Heading(level=level, text=title, anchor=github_anchor(title), line=i)
            pf.headings.append(h)
            if level <= 2:
                section = title
            continue

        if ref_re is not None:
            rm = ref_re.match(line)
            if rm:
                section = rm.group(1)

        for seg in code_free_segments(line):
            for m in LINK_RE.finditer(seg):
                label = m.group(1)
                target = m.group(2)
                if target.startswith("http") or target.startswith("#"):
                    continue
                pf.links.append(Link(label=label, target=target, section=section, line=i))

        for tok in BACKTICK_RE.findall(line):
            if tok.startswith("<") or " " in tok:
                continue
            pf.backticks.append(tok)

    return pf


def _collect_tables(pf: ParsedFile, body: str) -> None:
    raw_lines = body.splitlines()
    i = 0
    section = ""
    while i < len(raw_lines):
        line = raw_lines[i].strip()
        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            if len(m.group(1)) <= 2:
                section = m.group(2).strip()
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(raw_lines):
            sep = raw_lines[i + 1].strip()
            if re.match(r"^\|[\s:\-|]+\|?$", sep) and "-" in sep:
                headers = [c.strip() for c in line.strip("|").split("|")]
                j = i + 2
                rows: list[list[str]] = []
                while j < len(raw_lines):
                    r = raw_lines[j].strip()
                    if not r.startswith("|"):
                        break
                    if re.match(r"^#{1,6}\s", r):
                        break
                    rows.append([c.strip() for c in r.strip("|").split("|")])
                    j += 1
                pf.tables.append(Table(headers=headers, rows=rows, section=section, line=i + 1))
                i = j
                continue
        i += 1


# ---------------------------------------------------------------------------
# graph builder
# ---------------------------------------------------------------------------

class GraphBuilder:
    def __init__(self, cfg: dict[str, Any], root: Path):
        self.cfg = cfg
        self.root = root
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.files: dict[str, ParsedFile] = {}
        self.prefixes: dict[str, str] = cfg.get("prefixes", {})
        self.entry_files: dict[str, dict[str, Any]] = cfg.get("entryFiles", {})
        self._edge_keys: set[tuple[str, str, str, str]] = set()

    # -- node registry ---------------------------------------------------
    def add_node(self, nid: str, ntype: str, label: str, path: str, anchor: str | None = None) -> dict:
        if nid not in self.nodes:
            self.nodes[nid] = {"id": nid, "type": ntype, "label": label, "path": path}
        node = self.nodes[nid]
        if anchor and not node.get("anchor"):
            node["anchor"] = anchor
        return node

    def edge(self, src: str, dst: str, kind: str, context: str = "") -> None:
        key = (src, dst, kind, context)
        if key in self._edge_keys:
            return
        self._edge_keys.add(key)
        self.edges.append({"from": src, "to": dst, "kind": kind, "context": context})

    def resolve_node_id(self, file_path: str) -> str | None:
        """Map a scanned posix file path to a node id (DOC/SKILL/META)."""
        p = to_posix(file_path)
        if p in self.files:
            if p in self.entry_files:
                return f"META:{Path(p).stem}"
            if ".opencode/skills/" in p and p.endswith("/SKILL.md"):
                name = Path(p).parts[Path(p).parts.index("skills") + 1]
                return f"SKILL:{name}"
            if p == "AGENTS.md":
                return "META:AGENTS"
            if p == ".opencode/README.md":
                return "META:opencode-README"
            return f"DOC:{Path(p).stem}"
        return None

    @staticmethod
    def node_type_for(nid: str) -> str:
        if nid.startswith("SKILL:"):
            return "SKILL"
        if nid.startswith("META:"):
            return "META"
        return "DOC"

    def resolve_target_file(self, target: str, from_file: str) -> str | None:
        """Resolve a link target's base to a root-relative posix file path (or None)."""
        base, _, _ = target.partition("#")
        if not base:
            return None
        try:
            if base.startswith("/") or re.match(r"^[A-Za-z]:", base):
                return to_posix(Path(base).resolve().relative_to(self.root))
            parent = (self.root / from_file).parent
            return to_posix((parent / base).resolve().relative_to(self.root))
        except ValueError:
            return None

    def node_from_target(self, target: str, from_file: str) -> tuple[str | None, str | None]:
        """Resolve a markdown link target to (node_id, anchor) relative to from_file.

        指向**条目文件**（entryFiles，如 docs/CHANGELOG.md）的链接：
        - 带锚点（`CHANGELOG.md#g-002-...`）→ 直接解析到对应条目节点 `BUG:G-002`；
        - 无锚点（`CHANGELOG.md`）→ 落到文件节点（若注册了）或 None。
        条目文件自身不注册为 META 节点（_register_nodes 对 entry_files 会 continue），
        故带锚点的链接不能返回未注册的 `META:<stem>`，否则锚点校验一律误报「锚点不存在」。
        """
        base, _, anchor = target.partition("#")
        if not base:
            return None, anchor
        abs_target = self.resolve_target_file(target, from_file)
        if abs_target is None:
            return None, anchor
        if abs_target in self.entry_files and anchor:
            bug_id = self._bug_id_by_anchor(anchor)
            if bug_id:
                return f"BUG:{bug_id}", None
        if abs_target in self.files:
            return self.resolve_node_id(abs_target), anchor
        # may be a raw file we didn't scan (e.g. tools/*.py) -> check existence
        if (self.root / abs_target).is_file():
            return None, anchor
        return None, anchor

    # -- main ------------------------------------------------------------
    def run(self) -> None:
        self._scan()
        self._build_nodes()
        self._build_edges()
        self._lint()

    def _scan(self) -> None:
        cfg = self.cfg
        ignore: set[str] = {to_posix(p) for p in cfg.get("scan", {}).get("ignore", [])}
        # 部署快照是 AUTO-GENERATED 产物，绝不当作功能文档参与节点/孤儿统计
        repo_cfg = cfg.get("repo") or {}
        if repo_cfg.get("snapshotMarkdown"):
            ignore.add(to_posix(repo_cfg["snapshotMarkdown"]))
        ignore_prefixes = [to_posix(p) for p in cfg.get("scan", {}).get("ignorePrefixes", [])]
        roots = cfg.get("scan", {}).get("roots", ["docs"])
        ref_markers = cfg.get("refSections", ["相关历史条目"])
        for root in roots:
            base = self.root / root
            if not base.is_dir():
                continue
            for f in base.rglob("*.md"):
                rel = to_posix(f.relative_to(self.root))
                if rel in ignore or any(rel.startswith(pre) for pre in ignore_prefixes):
                    continue
                if rel in self.files:
                    continue
                try:
                    text = f.read_text(encoding="utf-8-sig")
                except OSError:
                    continue
                self.files[rel] = parse_file(rel, text, ref_markers)
        for f in cfg.get("scan", {}).get("extraFiles", []):
            p = self.root / f
            if not p.is_file():
                continue
            rel = to_posix(p.relative_to(self.root))
            if rel in self.files:
                continue
            try:
                text = p.read_text(encoding="utf-8-sig")
            except OSError:
                continue
            self.files[rel] = parse_file(rel, text, ref_markers)

    def _build_nodes(self) -> None:
        id_pattern = re.compile(self.cfg.get("idPattern", r"^([A-Z]+)-(\d+)$"))
        for path, entry_cfg in self.entry_files.items():
            pf = self.files.get(path)
            if not pf:
                self.errors.append(f"entry file not found: {path}")
                continue
            # 条目文件本体也登记为 META 节点（ref/mention 边需要它有声明，否则边指向空节点）
            self.add_node(f"META:{Path(path).stem}", "META", Path(path).stem, path)
            regex = re.compile(entry_cfg.get("heading", r"^([A-Z]+-\d+)\s*[:：]?\s*(.+)$"))
            ntype = entry_cfg.get("type", "BUG")
            for h in pf.headings:
                if h.level != 2:
                    continue
                m = regex.match(h.text)
                if not m:
                    continue
                eid = m.group(1)
                if not id_pattern.match(eid):
                    self.errors.append(f"{path}:{h.line} 条目 ID 不合法: {eid}")
                    continue
                prefix, num = eid.split("-", 1)
                if prefix not in self.prefixes:
                    self.errors.append(f"{path}:{h.line} 未知前缀: {prefix} ({eid})")
                nid = f"{ntype}:{eid}"
                if nid in self.nodes:
                    self.errors.append(f"重复条目 ID: {eid} ({path}:{h.line})")
                self.add_node(nid, ntype, h.text, path, h.anchor)

        for path, pf in self.files.items():
            if path in self.entry_files:
                continue
            nid = self.resolve_node_id(path)
            if nid is None:
                continue
            label = pf.frontmatter.get("name") or Path(path).stem
            self.add_node(nid, self.node_type_for(nid), label, path)

    def _build_edges(self) -> None:
        self._links_to_edges()
        self._tables_to_edges()
        self._backticks_to_edges()
        self._repo_edges()

    # -- link edges ------------------------------------------------------
    def _links_to_edges(self) -> None:
        id_pattern = re.compile(self.cfg.get("idPattern", r"^([A-Z]+)-(\d+)$"))
        ref_sections = self.cfg.get("refSections", ["相关历史条目"])
        ref_entry_files = self.cfg.get("refEntryFiles", ["docs/CHANGELOG.md"])
        for path, pf in self.files.items():
            src = self.resolve_node_id(path)
            if src is None:
                continue
            for link in pf.links:
                is_ref = any(k in link.section for k in ref_sections)
                node_id, anchor = self.node_from_target(link.target, path)
                # ref 路径需要“原始锚点”：node_from_target 对条目文件带锚点链接会返回 None 锚点
                # （已解析成 BUG:* 节点），故这里直接从 link.target 再取一次，保证 ref 边不丢。
                raw_anchor = link.target.partition("#")[2] or None
                target_file = self.resolve_target_file(link.target, path)
                ref_entry = target_file if (target_file and target_file in ref_entry_files) else ""
                if is_ref and ref_entry:
                    bug_id = self._bug_id_by_anchor(raw_anchor)
                    if bug_id is None:
                        self.errors.append(f"{path}:{link.line} 相关历史条目引用了 {ref_entry} 不存在的锚点: {link.target}")
                        continue
                    self.edge(src, f"BUG:{bug_id}", "ref", context=link.section)
                    continue
                if node_id is None:
                    continue
                if anchor:
                    if not self._anchor_exists(node_id, anchor):
                        self.errors.append(f"{path}:{link.line} 锚点不存在: {link.target} -> {node_id}")
                        continue
                kind = "ref" if is_ref else "mention"
                self.edge(src, node_id, kind, context=link.section)

    def _bug_id_by_anchor(self, anchor: str) -> str | None:
        for path, entry_cfg in self.entry_files.items():
            pf = self.files.get(path)
            if not pf:
                continue
            regex = re.compile(entry_cfg.get("heading", r"^([A-Z]+-\d+)\s*[:：]?\s*(.+)$"))
            for h in pf.headings:
                if h.anchor == anchor:
                    m = regex.match(h.text)
                    if m:
                        return m.group(1)
        return None

    def _anchor_exists(self, node_id: str, anchor: str) -> bool:
        """Does `anchor` name a heading in the document behind `node_id`?

        条目文件（entryFiles，如 docs/CHANGELOG.md）只把 §条目 注册成 BUG:* 节点，
        文件自身不会成为 META:* 节点。若拿到的 node_id 未注册（例如历史写法遗留的
        `META:CHANGELOG`），回退为“按文件路径查标题”，避免误报「锚点不存在」。
        """
        node = self.nodes.get(node_id)
        path = node["path"] if node else None
        if path is None:
            for cand in self.files:
                if self.resolve_node_id(cand) == node_id:
                    path = cand
                    break
            if path is None:
                stem = node_id.split(":", 1)[1] if ":" in node_id else node_id
                for cand in self.files:
                    if Path(cand).stem == stem:
                        path = cand
                        break
        if path is None:
            return False
        pf = self.files.get(path)
        if not pf:
            return False
        return any(h.anchor == anchor for h in pf.headings)

    # -- table edges -----------------------------------------------------
    def _tables_to_edges(self) -> None:
        id_pattern = re.compile(self.cfg.get("idPattern", r"^([A-Z]+)-(\d+)$"))
        checklist_heads = self.cfg.get("checklistHeadings", ["必须保证的功能", "回归清单"])
        source_col = self.cfg.get("checklistSourceColumn", "来源")

        for path, pf in self.files.items():
            src = self.resolve_node_id(path)
            if src is None:
                continue

            # checklist tables inside feature docs
            for tbl in pf.tables:
                # config-driven table edges (AGENTS mapping, doc index)
                for te in self.cfg.get("tableEdges", []):
                    if te.get("file") != path or not any(k in tbl.section for k in te.get("headings", [])):
                        continue
                    self._apply_table_edge(te, tbl, src)

                if not any(k in tbl.section for k in checklist_heads):
                    continue
                try:
                    sc = tbl.headers.index(source_col)
                except ValueError:
                    continue
                ctx_col = next((i for i, h in enumerate(tbl.headers) if h.startswith("保证")), None)
                num_col = next((i for i, h in enumerate(tbl.headers) if h.strip() == "#"), 0)
                for ridx, row in enumerate(tbl.rows):
                    if len(row) <= sc:
                        continue
                    ctx = ""
                    if ctx_col is not None and ctx_col < len(row):
                        ctx = row[ctx_col]
                    num = row[num_col].strip() if len(row) > num_col else ""
                    for tok in re.findall(r"[A-Z]+-\d+", row[sc]):
                        if not id_pattern.match(tok):
                            continue
                        if f"BUG:{tok}" not in self.nodes:
                            self.errors.append(f"{path} 回归清单引用了 CHANGELOG 缺失的条目: {tok}")
                            continue
                        context = f"回归清单"
                        if num:
                            context += f"#{num}"
                        if ctx:
                            context += f" 保证项: {ctx}"
                        self.edge(src, f"BUG:{tok}", "checklist", context=context)

    def _apply_table_edge(self, te: dict, tbl: Table, from_node: str) -> None:
        kind = te.get("kind", "mention")
        from_node = te.get("from") or from_node
        src_col = te.get("srcCol")
        doc_col = te.get("docCol")
        link_col = te.get("linkCol")
        for row in tbl.rows:
            if link_col is not None and len(row) > link_col:
                file = self._file_of(tbl)
                for m in LINK_RE.finditer(row[link_col]):
                    node_id, _ = self.node_from_target(m.group(2), file)
                    if node_id and node_id in self.nodes:
                        self.edge(from_node, node_id, kind, context=tbl.section)
                continue
            if src_col is not None and doc_col is not None and len(row) > max(src_col, doc_col):
                src_toks = BACKTICK_RE.findall(row[src_col]) or [row[src_col].strip()]
                for tok in src_toks:
                    if not tok:
                        continue
                    src_nid = f"SRC:{tok}"
                    self.add_node(src_nid, "SRC", tok, tok)
                    for doc in split_doc_names(row[doc_col]):
                        doc_nid = f"DOC:{Path(doc).stem}"
                        if doc_nid not in self.nodes:
                            self.warnings.append(f"映射表目标文档不存在: {doc} ({self._file_of(tbl)})")
                            continue
                        self.edge(src_nid, doc_nid, kind, context=tbl.section)

    def _file_of(self, tbl: Table) -> str:
        for path, pf in self.files.items():
            if any(t is tbl for t in pf.tables):
                return path
        return ""

    # -- backtick mention edges ------------------------------------------
    def _backticks_to_edges(self) -> None:
        for path, pf in self.files.items():
            src = self.resolve_node_id(path)
            if src is None:
                continue
            for tok in pf.backticks:
                rel = to_posix(tok)
                nid = self.resolve_node_id(rel)
                if nid is None:
                    # tolerate `docs/CHANGELOG.md` -> META node
                    if rel in self.entry_files:
                        nid = f"META:{Path(rel).stem}"
                        self.add_node(nid, self.node_type_for(nid), Path(rel).stem, rel)
                if nid is None or nid == src:
                    continue
                if not rel.endswith(".md"):
                    continue
                self.edge(src, nid, "mention", context="")

    # -- repo commit edges ----------------------------------------------
    def _repo_edges(self) -> None:
        """条目 ↔ 提交：把 tools/repo.py links 的索引接进图谱。

        边方向：条目 → 提交（kind=touches），于是 `graphgen_query node=DG-009`
        能直接列出「这条需求改过哪些提交」，提交侧则拿到反链。
        索引里引用已删除/改名的条目时**静默跳过**：历史索引不应把
        `--check` 变成红灯（否则删条目必然破 CI）。
        """
        repo_cfg = self.cfg.get("repo") or {}
        if not repo_cfg.get("enabled"):
            return
        rel = to_posix(repo_cfg.get("linksFile", "docs/repo-links.json"))
        path = self.root / rel
        if not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            self.warnings.append(f"提交索引无法解析: {rel}（重跑 python tools/repo.py links）")
            return
        by_entry = data.get("byEntry") or {}
        limit = int(repo_cfg.get("maxCommitNodes", 300))
        added = 0
        for eid in sorted(by_entry):
            entry_nid = self._entry_node_id(str(eid))
            if entry_nid is None:
                continue
            for item in by_entry[eid] or []:
                short = str(item.get("short") or "").strip()
                if not short:
                    continue
                if added >= limit:
                    self.warnings.append(f"提交节点超过 maxCommitNodes={limit}，其余已省略")
                    return
                cid = f"COMMIT:{short}"
                if cid not in self.nodes:
                    subject = str(item.get("subject") or "").strip()
                    self.add_node(cid, "COMMIT", subject[:80] or short, f"commit:{short}")
                    added += 1
                self.edge(entry_nid, cid, "touches", context=str(item.get("date") or ""))

    def _entry_node_id(self, eid: str) -> str | None:
        """按条目 ID 找已注册节点（条目类型由配置决定，如 BUG/FEAT）。"""
        suffix = ":" + eid
        for nid, node in self.nodes.items():
            if nid.endswith(suffix) and node.get("type") not in ("DOC", "SKILL", "META", "SRC", "COMMIT"):
                return nid
        return None

    # -- lint ------------------------------------------------------------
    def _lint(self) -> None:
        bug_nodes = {n["id"] for n in self.nodes.values() if n["type"] == "BUG"}
        incoming: set[str] = set()
        for e in self.edges:
            incoming.add(e["to"])
        for nid in sorted(bug_nodes):
            if nid not in incoming:
                self.warnings.append(f"孤儿条目（无任何文档引用）: {nid}")
        self._lint_orphan_docs()

    def _lint_orphan_docs(self) -> None:
        indexed: set[str] = set()
        for e in self.edges:
            if e["kind"] in ("index", "owns"):
                indexed.add(e["to"])
        if not indexed:
            return
        for nid in sorted(self.nodes):
            n = self.nodes[nid]
            if n["type"] != "DOC":
                continue
            if n["path"].startswith("docs/") and n["path"] not in self.files:
                continue
            if nid not in indexed and nid not in ("DOC:README", "DOC:TEMPLATE"):
                self.warnings.append(f"未入任何索引/映射表的文档: {nid}")


# ---------------------------------------------------------------------------
# outputs
# ---------------------------------------------------------------------------

def compute_backlinks(nodes: dict, edges: list[dict]) -> dict[str, list[dict]]:
    back: dict[str, list[dict]] = {}
    for nid in nodes:
        back[nid] = []
    for e in edges:
        back.setdefault(e["to"], []).append(
            {"from": e["from"], "kind": e["kind"], "context": e.get("context", "")}
        )
    return back


def emit_json(cfg: dict, nodes: dict, edges: list, backlinks: dict, errors: list, warnings: list) -> str:
    out = {
        "version": "1.0",
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "project": cfg.get("name", ""),
        "prefixes": cfg.get("prefixes", {}),
        "nodes": {nid: node for nid, node in nodes.items()},
        "edges": edges,
        "backlinks": backlinks,
        "lint": {"errors": errors, "warnings": warnings},
    }
    return json.dumps(out, ensure_ascii=False, indent=2) + "\n"


def emit_markdown(cfg: dict, nodes: dict, edges: list, backlinks: dict, errors: list, warnings: list) -> str:
    L: list[str] = []
    L.append("# 知识图谱索引（AUTO-GENERATED）")
    L.append("")
    L.append("> 由 `tools/graphgen.py` 生成，**请勿手改**。重新生成：`python tools/graphgen.py`。")
    L.append("> 规范数据见 `graph.json`（节点自带 `backlinks` 数组，模型无需全库 grep 即可读反链）。")
    L.append("")
    types: dict[str, int] = {}
    for n in nodes.values():
        types[n["type"]] = types.get(n["type"], 0) + 1
    typestr = " / ".join(f"{k} {v}" for k, v in sorted(types.items()))
    L.append("## 统计")
    L.append("")
    L.append(f"- 节点: {len(nodes)}（{typestr}）")
    L.append(f"- 边: {len(edges)}")
    L.append(f"- lint: {len(errors)} 错误 / {len(warnings)} 警告")
    if errors:
        for e in errors:
            L.append(f"  - ERROR: {e}")
    if warnings:
        for w in warnings:
            L.append(f"  - WARN: {w}")
    L.append("")

    L.append("## 反链索引")
    L.append("")
    for nid in sorted(nodes):
        n = nodes[nid]
        bl = backlinks.get(nid, [])
        L.append(f"### {nid} · {n['label']}")
        L.append("")
        loc = f"{n['path']}#{n['anchor']}" if n.get("anchor") else n["path"]
        L.append(f"- 路径: `{loc}`")
        if not bl:
            L.append("- 反链: 无")
        else:
            L.append(f"- 反链({len(bl)}):")
            for b in bl:
                extra = f" — {b['context']}" if b.get("context") else ""
                L.append(f"  - `{b['from']}` ({b['kind']}){extra}")
        L.append("")

    L.append("## 全部节点")
    L.append("")
    L.append("| id | type | label | path |")
    L.append("|----|------|-------|------|")
    for nid in sorted(nodes):
        n = nodes[nid]
        p = n["path"].replace("|", "/")
        L.append(f"| `{nid}` | {n['type']} | {n['label']} | `{p}` |")
    L.append("")

    L.append("## 全部边")
    L.append("")
    L.append("| from | to | kind |")
    L.append("|------|----|------|")
    for e in sorted(edges, key=lambda e: (e["from"], e["to"])):
        L.append(f"| `{e['from']}` | `{e['to']}` | {e['kind']} |")
    L.append("")
    return "\n".join(L)


def emit_mermaid(edges: list) -> str:
    L = ["graph LR"]
    for e in sorted(edges, key=lambda e: (e["from"], e["to"])):
        L.append(f'  "{e["from"]}"-->|"{e["kind"]}"|"{e["to"]}"')
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------------
# --init scaffold
# ---------------------------------------------------------------------------

INSTALL_MARKER = "<!-- graphgen:installed -->"
DIST_DIR_NAME = "graphgen-dist"
PLUGIN_PKG_VERSION = "2.0.32"


def find_dist_dir() -> Path | None:
    """Locate the distribution assets dir next to (or a few levels above) this script."""
    here = Path(__file__).resolve().parent
    for cand in (here, here.parent, here.parent.parent):
        d = cand / DIST_DIR_NAME
        if d.is_dir():
            return d
    return None


def cmd_init(target: str, name: str | None) -> int:
    dist = find_dist_dir()
    root = Path(target).resolve()
    root.mkdir(parents=True, exist_ok=True)
    project = name or root.name or "project"

    tools = root / "tools"
    tools.mkdir(parents=True, exist_ok=True)
    engine = Path(__file__).resolve()
    engine_out = tools.joinpath("graphgen.py")
    if engine_out.exists():
        print(f"[graphgen] 已存在 {to_posix(engine_out)}，跳过（如需重置请手动删除）")
    else:
        engine_out.write_text(engine.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"[graphgen] wrote {to_posix(engine_out)}")

    written: list[str] = []
    if dist is None:
        print(f"[graphgen] 未找到 {DIST_DIR_NAME} 资产目录，跳过 config 模板/skill/plugin/AGENTS", file=sys.stderr)
    else:
        cfg_tpl = dist / "graphgen.config.template.json"
        if cfg_tpl.is_file():
            cfg_out = tools / "graphgen.config.json"
            if cfg_out.exists():
                print(f"[graphgen] 已存在 {to_posix(cfg_out)}，跳过（如需重置请手动删除）")
            else:
                cfg_out.write_text(
                    cfg_tpl.read_text(encoding="utf-8").replace("{{NAME}}", project), encoding="utf-8"
                )
                written.append(to_posix(cfg_out))

        if dist.joinpath("skill-graphgen.md").is_file() and dist.joinpath("plugin-graphgen-watch.ts").is_file():
            occ = root / ".opencode"
            sk = occ / "skills" / "graphgen" / "SKILL.md"
            pl = occ / "plugins" / "graphgen-watch.ts"
            sk.parent.mkdir(parents=True, exist_ok=True)
            pl.parent.mkdir(parents=True, exist_ok=True)
            if sk.exists():
                print(f"[graphgen] 已存在 {to_posix(sk)}，跳过")
            else:
                sk.write_text(dist.joinpath("skill-graphgen.md").read_text(encoding="utf-8"), encoding="utf-8")
                written.append(to_posix(sk))
            if pl.exists():
                print(f"[graphgen] 已存在 {to_posix(pl)}，跳过")
            else:
                pl.write_text(dist.joinpath("plugin-graphgen-watch.ts").read_text(encoding="utf-8"), encoding="utf-8")
                written.append(to_posix(pl))
            pkg = occ / "package.json"
            if not pkg.exists():
                pkg.write_text(
                    '{\n  "dependencies": {\n    "@opencode/plugin": "' + PLUGIN_PKG_VERSION + '"\n  }\n}\n',
                    encoding="utf-8",
                )
                written.append(to_posix(pkg))
            print(f"[graphgen] opencode 接入完成（skill/plugin/package.json）；@opencode/plugin 运行时由 opencode 解析")

        dist_readme = dist / "README.md"
        for doc_name in ("README.md", "INSTALL.md"):
            src = dist / doc_name
            if not src.is_file():
                continue
            doc_out = root / "tools" / "graphgen-dist" / doc_name
            if doc_out.exists():
                print(f"[graphgen] 已存在 {to_posix(doc_out)}，跳过")
            else:
                doc_out.parent.mkdir(parents=True, exist_ok=True)
                doc_out.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
                written.append(to_posix(doc_out))

        snippet = dist / "AGENTS-snippet.md"
        agents = root / "AGENTS.md"
        if snippet.is_file():
            body = snippet.read_text(encoding="utf-8")
            if agents.exists():
                text = agents.read_text(encoding="utf-8")
                if INSTALL_MARKER in text:
                    print("[graphgen] AGENTS.md 已包含 graphgen 工作流（幂等跳过）")
                else:
                    agents.write_text(text.rstrip() + "\n\n" + body.rstrip() + "\n", encoding="utf-8")
                    print("[graphgen] AGENTS.md 已追加图谱/改动工作流片段")
                    written.append(to_posix(agents))
            else:
                agents.write_text(body.rstrip() + "\n", encoding="utf-8")
                written.append(to_posix(agents))
                print("[graphgen] 无 AGENTS.md，已创建并写入图谱/改动工作流片段")

    for w in written:
        print(f"[graphgen] wrote {w}")
    print("[graphgen] init done. 下一步: 编辑 tools/graphgen.config.json（name/prefixes/tableEdges），"
          "然后 `python tools/graphgen.py --check`。")
    return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Markdown knowledge-graph generator & linter")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="config JSON path (relative to --root)")
    ap.add_argument("--root", default=".", help="base directory for scanning & outputs")
    ap.add_argument("--check", action="store_true", help="lint only, write nothing; exit 1 on errors")
    ap.add_argument("--init", metavar="DIR", help="scaffold graphgen into another project directory")
    ap.add_argument("--name", help="project name used by --init (default: target dir name)")
    args = ap.parse_args()

    if args.init:
        return cmd_init(args.init, args.name)

    root = Path(args.root).resolve()
    cfg_path = root / args.config if not Path(args.config).is_absolute() else Path(args.config)
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
    except OSError as e:
        print(f"[graphgen] 无法读取配置 {cfg_path}: {e}", file=sys.stderr)
        return 2

    gb = GraphBuilder(cfg, root)
    gb.run()

    backlinks = compute_backlinks(gb.nodes, gb.edges)

    if args.check:
        for e in gb.errors:
            print(f"ERROR: {e}")
        for w in gb.warnings:
            print(f"WARN: {w}")
        print(f"[graphgen] check: {len(gb.nodes)} nodes, {len(gb.edges)} edges, "
              f"{len(gb.errors)} errors, {len(gb.warnings)} warnings")
        return 1 if gb.errors else 0

    out_cfg = cfg.get("output", {})
    for key, default in (("json", "docs/graph.json"), ("markdown", "docs/GRAPH.md"), ("mermaid", "docs/graph.mmd")):
        rel = out_cfg.get(key, default)
        out = root / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if key == "json":
            out.write_text(emit_json(cfg, gb.nodes, gb.edges, backlinks, gb.errors, gb.warnings), encoding="utf-8")
        elif key == "markdown":
            out.write_text(emit_markdown(cfg, gb.nodes, gb.edges, backlinks, gb.errors, gb.warnings), encoding="utf-8")
        else:
            out.write_text(emit_mermaid(gb.edges), encoding="utf-8")
        print(f"[graphgen] wrote {to_posix(out)}")

    for e in gb.errors:
        print(f"ERROR: {e}", file=sys.stderr)
    for w in gb.warnings:
        print(f"WARN: {w}", file=sys.stderr)
    print(f"[graphgen] done: {len(gb.nodes)} nodes, {len(gb.edges)} edges, "
          f"{len(gb.errors)} errors, {len(gb.warnings)} warnings")
    return 1 if gb.errors else 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        pass
    sys.exit(main())
