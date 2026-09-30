"""Skill subsystem for the sidecar.

Seeds a per-profile skills dir from the desktop app's bundled domain-skills,
matches a task+URL to the most relevant skills, and distills a skill from a
successful run. The matched skill bodies get injected into the agent's system
message via `extend_system_message` so the OSS model never needs to discover
site-specific mechanics from scratch.
"""
from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit


def seed_skills(profile_dir: Path, seed_dir: Path | None) -> Path:
    """Copy skill .md files from the seed source into <profile>/skills.

    Existing files are never overwritten (user edits win). Returns the
    profile skills dir.
    """
    skills_dir = profile_dir / 'skills'
    skills_dir.mkdir(parents=True, exist_ok=True)
    if seed_dir is None or not seed_dir.is_dir():
        return skills_dir
    for src in seed_dir.rglob('*.md'):
        rel = src.relative_to(seed_dir)
        dest = skills_dir / rel
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, dest)
        except OSError:
            continue
    return skills_dir


def _host_tokens(url: str) -> list[str]:
    if not url:
        return []
    host = re.sub(r'^[a-z][a-z0-9+.-]*://', '', url.strip(), flags=re.I)
    host = host.split('/')[0].split('@')[-1].split(':')[0].lower()
    parts = [p for p in re.split(r'[.\-]', host) if len(p) >= 2]
    # Fold "www" and common ccTLD noise away; keep the registrable-ish tokens.
    return [p for p in parts if p not in ('www', 'com', 'org', 'net', 'io', 'co', 'uk', 'eu')]


def _slug_to_tokens(stem: str) -> list[str]:
    return [p for p in re.split(r'[^a-z0-9]+', stem.lower()) if len(p) >= 2]


def _safe_hostname(url: str) -> str:
    if not url:
        return ''
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return ''
    return (host or '').lower()


def match_skills(task: str, url: str, skills_dir: Path, limit: int = 3) -> list[Path]:
    """Score every skill file in skills_dir against the task + URL.

    Scoring is deliberately simple: a hostname/domain token match is worth
    the most, keyword hits in the task text add a small boost. We don't run
    an embedding model inside the sidecar.
    """
    task_l = task.lower()
    host_tokens = _host_tokens(url)
    ranked: list[tuple[int, Path, str]] = []
    for file in skills_dir.rglob('*.md'):
        rel = file.relative_to(skills_dir)
        tokens = _slug_to_tokens(file.stem) + _slug_to_tokens(rel.parent.name)
        score = 0
        for t in tokens:
            if t in host_tokens:
                score += 10
                break
        text_l = file.stem.replace('-', ' ').replace('_', ' ').lower()
        if text_l and text_l in task_l:
            score += 4
        for t in tokens:
            if t in host_tokens and t not in task_l and len(t) > 3:
                score += 1
        if score > 0:
            ranked.append((score, file, rel.as_posix()))
    ranked.sort(key=lambda r: (-r[0], r[2]))
    return [p for _, p, _ in ranked[:limit]]


def build_system_instructions(matched: list[Path], skills_dir: Path) -> str:
    """Render matched skill bodies as an `extend_system_message` block."""
    if not matched:
        return ''
    blocks = ['You have the following site-specific skills for this task. '
              'Follow the mechanics described in the relevant sections before improvising.']
    for file in matched:
        try:
            body = file.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        rel = file.relative_to(skills_dir).as_posix()
        safe_body = body.replace('</skill>', '<\\/skill>')
        blocks.append(f'\n<skill path="{rel}">\n{safe_body.strip()}\n</skill>')
    return '\n'.join(blocks)


def distill_skill(
    profile_dir: Path,
    task: str,
    final: str,
    url: str | None = None,
    action_names: list[str] | None = None,
    was_successful: bool = True,
) -> Path | None:
    """Write a privacy-safe distilled skill after a successful run.

    Distilled skills live under <profile>/skills/distilled/ so they survive
    across runs for the same persistent browser profile. We deliberately do
    not persist raw task text, final output, or the full URL: those can contain
    credentials, personal data, search terms, or one-time codes. The learned
    artifact keeps only the public hostname and a bounded list of action names.
    """
    if not was_successful:
        return None
    out_dir = profile_dir / 'skills' / 'distilled'
    out_dir.mkdir(parents=True, exist_ok=True)
    hostname = _safe_hostname(url or '')
    host_tokens = _host_tokens(url or '')
    slug = '-'.join(dict.fromkeys(host_tokens))[:80] or 'run'
    # Append a counter so multiple distillations to the same host don't
    # overwrite each other.
    existing = list(out_dir.glob(f'{slug}*.md'))
    if existing:
        slug = f'{slug}-{len(existing) + 1}'
    actions = ', '.join(
        str(name).strip()[:80]
        for name in (action_names or [])[:12]
        if str(name).strip()
    )
    content = (
        f'# Distilled skill: {slug}\n\n'
        f'- distilled: {time.strftime("%Y-%m-%d %H:%M:%S")}\n'
        f'- host: {hostname or "n/a"}\n'
        f'- actions used: {actions or "n/a"}\n\n'
        '## What worked\n\n'
        'This skill was distilled from a successful run. Treat the recorded '
        'action sequence as a hint and verify the current page state before use.\n'
    )
    try:
        dest = out_dir / f'{slug}.md'
        dest.write_text(content, encoding='utf-8')
    except OSError:
        return None
    return dest


def skill_payload_for_run(task: str, url: str, profile_dir: Path, seed_dir: Path | None) -> str:
    """One-shot helper used by __init__.py: seed, match, and render."""
    skill_dir = seed_skills(profile_dir, seed_dir)
    matched = match_skills(task, url, skill_dir)
    return build_system_instructions(matched, skill_dir)