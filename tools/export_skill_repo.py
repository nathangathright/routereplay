#!/usr/bin/env python3
"""Build a clean, history-free distribution from an explicit source allowlist."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SKILL = Path("skills/cinematic-flight-videos")
EXCLUDED_DIRS = {
    ".git", ".venv", "__pycache__", "node_modules", "data", "outputs", "cache",
    "caches", ".pytest_cache",
}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}
ROOT_FILES = (
    "README.md", "LICENSE", "package.json", ".gitattributes", "tools/export_skill_repo.py",
    "tools/list_skills.py", "tools/test_portable.py", ".github/workflows/validate.yml",
    "tests/test_trip.py", "tests/test_data.py", "tests/test_engine.py",
    "tests/test_radiometry.py", "tests/test_transport.py", "tests/test_causal_lights.py",
    "tests/test_trajectories.py", "tests/test_itinerary_edges.py", "tests/test_terrain_tiles.py",
    "tests/test_adversarial.py", "tests/test_pipeline.py",
    "tests/test_lighting_profile.py", "tests/test_aircraft_assets.py",
    "tests/test_gfs_archive.py", "tests/test_joint_transport.py",
    "tests/test_solar_visibility.py", "tests/test_acceleration.py", "tests/test_metal_compute.py",
    "tests/test_export_skill.py", "tests/test_cityglow.py", "tests/test_cloudlighting.py", "tests/test_moonlighting.py",
    "tests/test_surface_moonlight.py", "tests/test_lunar_incident.py",
    "tests/test_lamp_spectra.py", "tests/test_city_color.py", "tests/test_labels.py", "tests/test_cloudshapes.py",
    "tests/test_metal_clouds.py", "tests/test_atmosphere_lookup.py", "tests/test_scene_cache.py", "tests/test_cloud_view.py", "tests/test_metal_weather.py",
    "tests/test_metal_atmosphere.py", "tests/test_cloud_source.py", "tests/test_calibration.py", "tests/test_data_adapters.py",
    "tests/test_volume_reconstruction.py", "tests/test_cloud_reconstruction.py", "tests/test_air_reconstruction.py",
    "tests/test_environmentlighting.py", "tests/test_lunar_scattering.py", "tests/test_render_budget.py",
    "tests/test_chase_camera.py", "tests/test_chase_weather.py", "tests/test_chase_preview.py",
    "tests/test_chase_atmosphere.py", "tests/test_chase_cloudscape.py", "tests/test_chase_cloud_grid.py",
    "tests/test_aircraft_attitude.py", "tests/test_pacing.py", "tests/test_media_moments.py", "tests/test_storytelling.py",
    "tests/test_track_imports.py", "tests/test_telemetry.py", "tests/test_telemetry_overlay.py", "tests/test_track_workflow.py",
)
PRIVATE_PATTERNS = (
    ("absolute home path", re.compile(r"/(?:Users|home)/[A-Za-z0-9_.-]+/")),
    ("Windows home path", re.compile(r"[A-Za-z]:[\\/]Users[\\/]", re.I)),
    ("private tailnet hostname", re.compile(r"\b[\w.-]+\.ts\.net\b", re.I)),
    ("mailbox link", re.compile(r"https?://(?:mail\.google\.com|outlook\.live\.com|outlook\.office\.com)/", re.I)),
    ("personal document link", re.compile(r"https?://docs\.google\.com/(?:document|spreadsheets|presentation)/d/", re.I)),
    ("personal email address", re.compile(r"\b[\w.+-]+@(?:gmail|icloud|hotmail|yahoo|protonmail|outlook)\.com\b", re.I)),
    ("private key material", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
)
MAX_FILE_BYTES = 1024 * 1024
MEDIA_SUFFIXES = {
    '.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mp3', '.wav', '.m4a',
    '.png', '.jpg', '.jpeg', '.heic', '.webp', '.gif', '.tif', '.tiff', '.exr', '.hdr',
    '.blend', '.glb', '.gltf', '.fbx', '.npz', '.npy', '.nc', '.grib', '.grib2',
    '.zip', '.gz', '.7z', '.pdf', '.gpx', '.kml', '.kmz', '.igc',
}
BUNDLED_BINARY_FILES = {(SKILL / 'assets/fonts/dosis/Dosis-Variable.ttf').as_posix()}
PRIVATE_DIRS = {'.local', '.ssh', '.aws', '.config', 'private', 'trips', 'tracks', 'bookings'}
PORTABLE_IGNORE = '''# Local runtime and generated output
__pycache__/
*.py[cod]
.venv/
venv/
.pytest_cache/
.DS_Store
node_modules/
/.local/
/data/
/cache/
/caches/
/renders/
/outputs/
/reports/
/previews/
/dist/

# Personal trips, evidence and local preview sites
/private/
/trips/
/tracks/
/bookings/
/trip*.json
/itinerary*.json
/booked-itinerary.json
/flight-evidence.json
/preview-site/
/outbound/
/return/
/preserved-outbound*/
/asset-manifest.json

# Credentials and machine settings
.env
.env.*
.cdsapirc
.netrc
.pypirc
.npmrc
.ssh/
.aws/
.config/
credentials*.json
secrets*.json
secrets*.yaml
secrets*.yml
*.pem
*.key
*.p12
*.pfx

# Media, downloaded data, models and track recordings
*.mp4
*.mov
*.m4v
*.webm
*.avi
*.mkv
*.mp3
*.wav
*.m4a
*.png
*.jpg
*.jpeg
*.heic
*.webp
*.gif
*.tif
*.tiff
*.exr
*.hdr
*.blend
*.blend1
*.glb
*.gltf
*.fbx
*.npz
*.npy
*.nc
*.grib
*.grib2
*.zip
*.gz
*.7z
*.pdf
*.gpx
*.kml
*.kmz
*.igc
'''


def tracked_files(root: Path, allowed_sources: list[Path]) -> list[Path]:
    """Fail closed when a public checkout tracks anything outside the export."""
    output = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'],
                            check=True, capture_output=True).stdout
    names = [os.fsdecode(name) for name in output.split(b'\0') if name]
    allowed = {p.relative_to(root).as_posix() for p in allowed_sources}
    allowed.update({'.gitignore', 'distribution-manifest.json'})
    unexpected = sorted(set(names) - allowed)
    if unexpected:
        raise ValueError('Files outside the public allowlist:\n' + '\n'.join(unexpected))
    if (root / '.gitignore').read_text() != PORTABLE_IGNORE:
        raise ValueError('.gitignore must match the portable ignore rules')
    return [root / name for name in names]


def source_files(root: Path) -> list[Path]:
    """Only the portable skill, distribution tools, and portable tests may leave."""
    root = root.resolve()
    required = [root / relative for relative in ROOT_FILES] + [root / SKILL / "SKILL.md"]
    for path in required:
        if not path.is_file():
            raise ValueError(f"Missing required distribution file: {path.relative_to(root)}")
    result: list[Path] = []
    skill_root = root / SKILL
    if skill_root.is_symlink():
        raise ValueError(f"Symlinks are not allowed in a distribution: {SKILL}")
    for current, directories, filenames in os.walk(skill_root, followlinks=False):
        directories[:] = sorted(d for d in directories if d not in EXCLUDED_DIRS)
        for directory in directories:
            path = Path(current) / directory
            if path.is_symlink():
                raise ValueError(f"Symlinks are not allowed in a distribution: {path.relative_to(root)}")
        for name in sorted(filenames):
            path = Path(current) / name
            if name == ".DS_Store" or path.suffix in EXCLUDED_SUFFIXES:
                continue
            result.append(path)
    result.extend(root / relative for relative in ROOT_FILES)
    return sorted(set(result), key=lambda path: path.relative_to(root).as_posix())


def audit(root: Path, files: list[Path]) -> list[dict[str, object]]:
    root = root.resolve()
    entries: list[dict[str, object]] = []
    errors: list[str] = []
    for path in files:
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            errors.append(f"{relative}: expected a regular file inside the repository")
            continue
        name = path.name.lower()
        if (set(part.lower() for part in path.relative_to(root).parts[:-1]) & PRIVATE_DIRS
                or name == '.env' or name.startswith('.env.')
                or name in {'.cdsapirc', '.netrc', '.pypirc', '.npmrc'}
                or name.startswith(('credentials', 'secrets'))
                or path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'}):
            errors.append(f'{relative}: private or credential file')
        if path.suffix.lower() in MEDIA_SUFFIXES or name.endswith('.blend1'):
            errors.append(f'{relative}: media, recording or generated asset')
        if path.stat().st_size > MAX_FILE_BYTES:
            errors.append(f'{relative}: exceeds the 1 MiB public file limit')
            continue
        raw = path.read_bytes()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = ""
        if (not content or '\0' in content) and raw and relative not in BUNDLED_BINARY_FILES:
            errors.append(f'{relative}: unexpected binary file')
        for label, pattern in PRIVATE_PATTERNS:
            match = pattern.search(content)
            if match:
                line = content.count("\n", 0, match.start()) + 1
                errors.append(f"{relative}:{line}: {label}")
        entries.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    if errors:
        raise ValueError("Distribution audit failed:\n" + "\n".join(errors))
    return entries


def export(root: Path, destination: Path, files: list[Path], entries: list[dict[str, object]]) -> None:
    root = root.resolve()
    if destination.is_symlink():
        raise ValueError("The destination must not be a symlink")
    destination = destination.resolve()
    if destination == root or destination.is_relative_to(root / SKILL):
        raise ValueError("Choose a destination outside the skill and repository root itself")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError(f"Destination is not an empty directory: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
    try:
        for source in files:
            target = staging / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        (staging/'.gitignore').write_text(PORTABLE_IGNORE)
        entries = entries + [{'path': '.gitignore', 'bytes': len(PORTABLE_IGNORE.encode()),
                              'sha256': hashlib.sha256(PORTABLE_IGNORE.encode()).hexdigest()}]
        manifest = {"schema_version": 1, "files": entries}
        (staging / "distribution-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if destination.exists():
            destination.rmdir()  # Only an already-checked empty directory can be removed.
        staging.rename(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Audit the distribution allowlist without copying files")
    parser.add_argument("--check-tracked", action="store_true", help="Audit every tracked file in a clean public checkout")
    parser.add_argument("--destination", type=Path, default=ROOT / "dist/routereplay")
    args = parser.parse_args()
    try:
        files = source_files(ROOT)
        if args.check_tracked:
            files = tracked_files(ROOT, files)
        entries = audit(ROOT, files)
        if args.check or args.check_tracked:
            print(json.dumps({"ok": True, "files": len(entries), "bytes": sum(e["bytes"] for e in entries)}))
        else:
            export(ROOT, args.destination, files, entries)
            print(f"Exported {len(entries)} files to {args.destination.resolve()}")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
