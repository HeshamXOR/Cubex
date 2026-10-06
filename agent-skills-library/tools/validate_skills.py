#!/usr/bin/env python3
"""Validate every skill in ./skills and generate index.json.

Checks (errors fail the run, warnings do not):
  E  SKILL.md exists, frontmatter parses, name/description present
  E  name: 1-64 chars, lowercase letters/digits/hyphens, matches directory, no reserved words
  E  description: non-empty, <= 1024 chars, no angle brackets
  E  SKILL.md body <= 500 lines
  E  every file referenced from SKILL.md exists
  W  reference files > 100 lines without a contents section
  W  files in references/ or assets/ that SKILL.md never mentions
  W  description does not contain a 'use when' style trigger phrase

Usage:  python tools/validate_skills.py [--no-index]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skill_loader import SKILLS_DIR, SkillError, load_skill, parse_frontmatter  # noqa: E402

NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RESERVED = ("anthropic", "claude")
PATH_RE = re.compile(r"`((?:[a-z0-9-]+/)?(?:references|assets|scripts)/[A-Za-z0-9_.\-/]+)`")
MAX_BODY_LINES = 500


def check_skill(d: Path, root: Path) -> tuple[list[str], list[str], dict | None]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        skill = load_skill(d)
    except SkillError as exc:
        return [str(exc)], warnings, None

    name, desc = skill.name, skill.description
    if len(name) > 64 or not NAME_RE.match(name):
        errors.append(f"{d.name}: invalid name '{name}'")
    if name != d.name:
        errors.append(f"{d.name}: name '{name}' must match directory name")
    if any(r in name for r in RESERVED):
        errors.append(f"{d.name}: name contains a reserved word")
    if len(desc) > 1024:
        errors.append(f"{d.name}: description is {len(desc)} chars (max 1024)")
    if "<" in desc or ">" in desc:
        errors.append(f"{d.name}: description must not contain angle brackets")
    if not re.search(r"\buse (whenever|when|this|for)\b", desc, re.I):
        warnings.append(f"{d.name}: description has no 'Use when...' trigger phrase")

    text = skill.skill_file.read_text(encoding="utf-8")
    _, body = parse_frontmatter(text)
    n_lines = len(body.splitlines())
    if n_lines > MAX_BODY_LINES:
        errors.append(f"{d.name}: SKILL.md body has {n_lines} lines (max {MAX_BODY_LINES})")

    mentioned: set[Path] = set()
    for ref in PATH_RE.findall(body):
        prefix, _, rest = ref.partition("/")
        if (root / prefix).is_dir() and rest.split("/")[0] in ("references", "assets", "scripts"):
            target = root / ref                # cross-skill reference like other-skill/references/x.md
        else:
            target = d / ref
        if not target.exists():
            errors.append(f"{d.name}: referenced file not found: {ref}")
        else:
            mentioned.add(target.resolve())

    files = []
    for sub in ("references", "assets", "scripts"):
        sd = d / sub
        if not sd.is_dir():
            continue
        for f in sorted(p for p in sd.rglob("*") if p.is_file()):
            rel = f.relative_to(d).as_posix()
            files.append(rel)
            if f.resolve() not in mentioned:
                warnings.append(f"{d.name}: {rel} is not referenced from SKILL.md")
            if f.suffix == ".md" and sub == "references":
                content = f.read_text(encoding="utf-8")
                if len(content.splitlines()) > 100 and not re.search(r"^#+\s*Contents", content, re.M):
                    warnings.append(f"{d.name}: {rel} is over 100 lines without a Contents section")

    entry = {
        "name": name,
        "description": desc,
        "path": f"skills/{d.name}/SKILL.md",
        "category": skill.metadata.get("category", ""),
        "version": skill.metadata.get("version", ""),
        "body_lines": n_lines,
        "files": files,
    }
    return errors, warnings, entry


def main(argv: list[str]) -> int:
    root = SKILLS_DIR
    dirs = sorted(p for p in root.iterdir() if p.is_dir())
    all_err: list[str] = []
    all_warn: list[str] = []
    index = []
    seen: set[str] = set()
    for d in dirs:
        errs, warns, entry = check_skill(d, root)
        all_err += errs
        all_warn += warns
        if entry:
            if entry["name"] in seen:
                all_err.append(f"duplicate skill name {entry['name']}")
            seen.add(entry["name"])
            index.append(entry)

    for w in all_warn:
        print(f"WARN  {w}")
    for e in all_err:
        print(f"ERROR {e}")
    print(f"\n{len(index)} skills checked: {len(all_err)} error(s), {len(all_warn)} warning(s)")

    if "--no-index" not in argv and not all_err:
        out = root.parent / "index.json"
        out.write_text(json.dumps({"skills": index}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {out.name}")
    return 1 if all_err else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
