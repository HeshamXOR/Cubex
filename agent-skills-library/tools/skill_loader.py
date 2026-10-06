#!/usr/bin/env python3
"""Minimal skill loader for an agent harness (progressive disclosure).

Level 1  catalog_prompt()  -> put name + description of every skill in the system prompt
Level 2  read_skill(name)  -> load SKILL.md body when the agent decides a skill is relevant
Level 3  read_resource()   -> load a reference/asset file on demand (path-traversal safe)

No third-party dependencies. Python 3.9+.

CLI:
  python tools/skill_loader.py catalog
  python tools/skill_loader.py show <skill>
  python tools/skill_loader.py resource <skill> <relative/path>
  python tools/skill_loader.py suggest "<user request>"
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


class SkillError(Exception):
    pass


@dataclass
class Skill:
    name: str
    description: str
    path: Path                      # directory containing SKILL.md
    metadata: dict[str, str] = field(default_factory=dict)
    frontmatter: dict = field(default_factory=dict)

    @property
    def skill_file(self) -> Path:
        return self.path / "SKILL.md"


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse the small YAML subset used by skills: scalars and one nested mapping."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise SkillError("missing YAML frontmatter delimited by --- lines")
    raw, body = m.group(1), m.group(2)
    data: dict = {}
    current_map: dict | None = None
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")):            # nested key under a mapping
            if current_map is None:
                raise SkillError(f"unexpected indentation: {line!r}")
            k, _, v = line.strip().partition(":")
            current_map[k.strip()] = _unquote(v)
            continue
        k, sep, v = line.partition(":")
        if not sep:
            raise SkillError(f"invalid frontmatter line: {line!r}")
        k, v = k.strip(), v.strip()
        if v == "":
            current_map = data[k] = {}
        else:
            current_map = None
            data[k] = _unquote(v)
    return data, body


def load_skill(skill_dir: Path) -> Skill:
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        raise SkillError(f"{skill_dir.name}: SKILL.md not found")
    fm, _ = parse_frontmatter(skill_file.read_text(encoding="utf-8"))
    for key in ("name", "description"):
        if not fm.get(key):
            raise SkillError(f"{skill_dir.name}: frontmatter field '{key}' is required")
    meta = fm.get("metadata") if isinstance(fm.get("metadata"), dict) else {}
    return Skill(name=fm["name"], description=fm["description"], path=skill_dir,
                 metadata=meta, frontmatter=fm)


def discover_skills(root: Path = SKILLS_DIR) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    for d in sorted(p for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").exists()):
        skill = load_skill(d)
        if skill.name in skills:
            raise SkillError(f"duplicate skill name: {skill.name}")
        skills[skill.name] = skill
    return skills


def catalog_prompt(skills: dict[str, Skill]) -> str:
    """Level 1: compact catalog for the system prompt."""
    lines = ["<available_skills>"]
    for s in skills.values():
        lines += ["  <skill>",
                  f"    <name>{escape(s.name)}</name>",
                  f"    <description>{escape(s.description)}</description>",
                  f"    <location>{escape(str(s.skill_file))}</location>",
                  "  </skill>"]
    lines.append("</available_skills>")
    return "\n".join(lines)


def read_skill(skills: dict[str, Skill], name: str) -> str:
    """Level 2: full SKILL.md contents (frontmatter stripped)."""
    if name not in skills:
        raise SkillError(f"unknown skill: {name}. Available: {', '.join(skills)}")
    _, body = parse_frontmatter(skills[name].skill_file.read_text(encoding="utf-8"))
    return body.lstrip("\n")


def read_resource(skills: dict[str, Skill], name: str, rel_path: str,
                  max_bytes: int = 400_000) -> str:
    """Level 3: read a file inside the skill folder. Rejects paths that escape it."""
    if name not in skills:
        raise SkillError(f"unknown skill: {name}")
    base = skills[name].path.resolve()
    target = (base / rel_path).resolve()
    if base != target and base not in target.parents:
        raise SkillError("path escapes the skill directory")
    if not target.is_file():
        raise SkillError(f"resource not found: {rel_path}")
    if target.stat().st_size > max_bytes:
        raise SkillError("resource too large to load into context")
    return target.read_text(encoding="utf-8")


_WORD = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with", "is", "it", "use",
         "when", "whenever", "that", "this", "as", "be", "by", "at", "from", "user", "asks",
         "task", "any", "even", "if", "not", "does", "says", "say", "also", "such", "into"}


def suggest(skills: dict[str, Skill], query: str, top: int = 3) -> list[tuple[str, int]]:
    """Naive keyword overlap, only for sanity-checking descriptions. The model should
    make the real decision from the catalog; do not use this as the production router."""
    q = {w for w in _WORD.findall(query.lower()) if w not in _STOP}
    scored = []
    for s in skills.values():
        d = {w for w in _WORD.findall((s.name.replace("-", " ") + " " + s.description).lower())}
        scored.append((s.name, len(q & d)))
    return sorted((x for x in scored if x[1] > 0), key=lambda x: -x[1])[:top]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    skills = discover_skills()
    cmd = argv[1]
    try:
        if cmd == "catalog":
            print(catalog_prompt(skills))
        elif cmd == "show" and len(argv) == 3:
            print(read_skill(skills, argv[2]))
        elif cmd == "resource" and len(argv) == 4:
            print(read_resource(skills, argv[2], argv[3]))
        elif cmd == "suggest" and len(argv) == 3:
            print(json.dumps(suggest(skills, argv[2]), indent=2))
        else:
            print(__doc__)
            return 1
    except SkillError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except BrokenPipeError:          # e.g. piping into `head`
        sys.exit(0)
