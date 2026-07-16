#!/usr/bin/env python3
"""
One-off migration script: converts the old Mintlify docs/ tree into
Docusaurus-compatible MDX under apps/docs/docs/.

Handles:
  - <Note>/<Tip> -> Docusaurus admonitions
  - <Frame><img src="/images/x.png" /></Frame> -> plain markdown image
  - <Card>/<CardGroup> -> plain markdown bullet link lists
  - <Accordion title="X">...</Accordion> -> <details><summary>X</summary>...</details>
  - image paths /images/x.png -> /img/docs/x.png (matches static/img/docs copy)

Intentionally does NOT touch docs/api-reference/* (those are auto-generated
by the docusaurus-plugin-openapi-docs plugin from openapi.yml instead) or
docs/mint.json (Mintlify-specific, superseded by docusaurus.config.ts).

Run once from repo root: python3 scripts/migrate-docs.py
"""
import re
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "docs"
DEST = REPO_ROOT / "apps" / "docs" / "docs"

# Top-level content files/dirs to migrate (excludes api-reference, mint.json,
# openapi.yml, logo/, favicon.svg, README.md - those are handled separately
# or superseded)
INCLUDE = [
    "introduction.mdx",
    "quickstart.mdx",
    "changelog.mdx",
    "fundamentals",
    "actions",
    "integrations",
    "oss",
]


def convert_note_tip(text: str) -> str:
    text = re.sub(
        r"<Note>(.*?)</Note>",
        lambda m: f":::note\n{m.group(1).strip()}\n:::",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"<Tip>(.*?)</Tip>",
        lambda m: f":::tip\n{m.group(1).strip()}\n:::",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"<Warning>(.*?)</Warning>",
        lambda m: f":::warning\n{m.group(1).strip()}\n:::",
        text,
        flags=re.DOTALL,
    )
    return text


def convert_frame(text: str) -> str:
    def repl(m):
        inner = m.group(1)
        src_match = re.search(r'src="([^"]+)"', inner)
        alt_match = re.search(r'alt="([^"]+)"', inner)
        if not src_match:
            return ""
        src = src_match.group(1).replace("/images/", "/img/docs/")
        alt = alt_match.group(1) if alt_match else ""
        return f"![{alt}]({src})"

    return re.sub(r"<Frame>\s*(.*?)\s*</Frame>", repl, text, flags=re.DOTALL)


def convert_accordion(text: str) -> str:
    def repl(m):
        title = m.group(1)
        body = m.group(2).strip()
        return f"<details>\n<summary>{title}</summary>\n\n{body}\n\n</details>"

    return re.sub(
        r'<Accordion\s+title="([^"]+)"\s*>(.*?)</Accordion>',
        repl,
        text,
        flags=re.DOTALL,
    )


def convert_cards(text: str) -> str:
    def card_repl(m):
        block = m.group(0)
        title_match = re.search(r'title="([^"]+)"', block)
        href_match = re.search(r'href="([^"]+)"', block)
        # description is the text between the closing '>' of the opening tag
        # and the closing </Card>
        desc_match = re.search(r">\s*([^<]+?)\s*</Card>", block, flags=re.DOTALL)
        title = title_match.group(1) if title_match else ""
        href = href_match.group(1) if href_match else "#"
        desc = desc_match.group(1).strip() if desc_match else ""
        return f"- **[{title}]({href})** - {desc}\n"

    text = re.sub(r"<Card\b.*?</Card>", card_repl, text, flags=re.DOTALL)
    # Drop the now-empty CardGroup wrapper tags, keep the bullet list inside
    text = re.sub(r"<CardGroup[^>]*>\s*", "\n", text)
    text = re.sub(r"\s*</CardGroup>", "\n", text)
    return text


def convert_file(path: Path, dest_path: Path):
    text = path.read_text(encoding="utf-8")
    text = convert_note_tip(text)
    text = convert_frame(text)
    text = convert_accordion(text)
    text = convert_cards(text)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_text(text, encoding="utf-8")


def main():
    converted = []
    for entry in INCLUDE:
        src_path = SRC / entry
        if src_path.is_file():
            dest_path = DEST / entry
            convert_file(src_path, dest_path)
            converted.append(str(dest_path.relative_to(REPO_ROOT)))
        elif src_path.is_dir():
            for f in src_path.rglob("*.mdx"):
                rel = f.relative_to(SRC)
                dest_path = DEST / rel
                convert_file(f, dest_path)
                converted.append(str(dest_path.relative_to(REPO_ROOT)))

    print(f"Converted {len(converted)} files:")
    for c in converted:
        print(f"  {c}")


if __name__ == "__main__":
    main()
