#!/usr/bin/env python3
"""List installable skills without depending on a package registry."""
from pathlib import Path
import re


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    paths = sorted((root / "skills").glob("*/SKILL.md"))
    for path in paths:
        content = path.read_text()
        match = re.match(r"\A---\s*\n(.*?)\n---(?:\n|$)", content, re.S)
        name = re.search(r"^name:\s*([a-z0-9-]+)\s*$", match[1], re.M) if match else None
        if not name or name[1] != path.parent.name:
            raise SystemExit(f"Invalid skill name or frontmatter: {path.relative_to(root)}")
        print(f"{name[1]}\t{path.relative_to(root).as_posix()}")
    if not paths:
        raise SystemExit("No installable skills found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
