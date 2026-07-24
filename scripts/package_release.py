#!/usr/bin/env python3
"""Build and package a Windows release for Brosdk Assistant.

The Windows package intentionally contains only the unpacked extension directory
under extension/chrome-mv3. The zipped extension build is copied as a separate
release asset so users do not see duplicate install choices inside the package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION_DIR = ROOT / "extension"
NATIVE_DIR = ROOT / "native-host"
DEFAULT_OUTPUT_DIR = ROOT / ".output" / "release"


def command_name(name: str) -> str:
    if os.name == "nt" and shutil.which(f"{name}.cmd"):
        return f"{name}.cmd"
    return name


def run(cmd: list[str], cwd: Path) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def read_extension_version() -> str:
    package = json.loads((EXTENSION_DIR / "package.json").read_text(encoding="utf-8"))
    return str(package["version"])


def read_cargo_version() -> str:
    cargo = (NATIVE_DIR / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', cargo)
    if not match:
        raise RuntimeError("Could not read native-host version from Cargo.toml")
    return match.group(1)


def read_manifest_version() -> str:
    config = (EXTENSION_DIR / "wxt.config.ts").read_text(encoding="utf-8")
    match = re.search(r"version:\s*['\"]([^'\"]+)['\"]", config)
    if not match:
        raise RuntimeError("Could not read extension manifest version from wxt.config.ts")
    return match.group(1)


def assert_inside(path: Path, parent: Path) -> None:
    resolved = path.resolve()
    resolved_parent = parent.resolve()
    if resolved != resolved_parent and resolved_parent not in resolved.parents:
        raise RuntimeError(f"Refusing to operate outside output directory: {resolved}")


def remove_tree(path: Path, output_dir: Path) -> None:
    if not path.exists():
        return
    assert_inside(path, output_dir)
    shutil.rmtree(path)


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def find_extension_zip(version: str) -> Path:
    dist_dir = EXTENSION_DIR / "dist"
    candidates = sorted(dist_dir.glob(f"*-{version}-chrome.zip"))
    if not candidates:
        raise RuntimeError(f"Could not find WXT chrome zip in {dist_dir}")
    if len(candidates) > 1:
        raise RuntimeError(f"Found multiple WXT chrome zips: {candidates}")
    return candidates[0]


def write_install_notes(path: Path, version: str) -> None:
    notes = f"""Brosdk Assistant v{version} - Windows

Files:
- extension/chrome-mv3: unpacked Chrome/Edge extension directory
- native-host/target/release/brosdk-assistant-native.exe: Windows native messaging host
- native-host/scripts/install-windows.ps1: native host registry installer
- native-host/scripts/uninstall-windows.ps1: installed-files and registry uninstaller

Install:
1. Close Chrome or Edge before upgrading an existing installation.
2. From this package root, run:
   powershell -ExecutionPolicy Bypass -File .\\native-host\\scripts\\install-windows.ps1
3. On first install, the script copies the extension to a stable directory and
   asks for its extension ID. Follow the displayed chrome://extensions steps.
4. Reload the extension and open its options page.
5. Configure API type, base URL, API key, model name, and browser tools source.

Installed files are stored under:
%LOCALAPPDATA%\\BrosdkAssistant

The native settings file is stored at:
%APPDATA%\\BrosdkAssistant\\settings.json

Upgrade:
- Extract the new Windows package and run install-windows.ps1 again.
- The saved extension ID and browser registrations are reused.

Uninstall:
  powershell -ExecutionPolicy Bypass -File $env:LOCALAPPDATA\\BrosdkAssistant\\uninstall-windows.ps1

Add -RemoveSettings to also delete settings and the default workspace.

For Chrome Web Store or packed-extension distribution, use the separate asset:
brosdk-assistant-extension-v{version}-chrome.zip
"""
    path.write_text(notes, encoding="utf-8")


def zip_directory(src_dir: Path, desired_zip: Path, output_dir: Path) -> Path:
    assert_inside(src_dir, output_dir)
    assert_inside(desired_zip, output_dir)

    tmp_dir = output_dir / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_zip = tmp_dir / f"{desired_zip.stem}-{int(time.time())}.zip"

    with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(p for p in src_dir.rglob("*") if p.is_file()):
            archive.write(file_path, file_path.relative_to(src_dir).as_posix())

    try:
        if desired_zip.exists():
            desired_zip.unlink()
        tmp_zip.replace(desired_zip)
        return desired_zip
    except OSError as exc:
        fallback = output_dir / f"{desired_zip.stem}-{time.strftime('%Y%m%d%H%M%S')}.zip"
        tmp_zip.replace(fallback)
        print(
            f"Warning: could not replace {desired_zip.name}: {exc}. "
            f"Wrote {fallback.name} instead.",
            file=sys.stderr,
        )
        return fallback


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def build(skip_build: bool, skip_tests: bool) -> None:
    if skip_build:
        return

    npm = command_name("npm")
    cargo = command_name("cargo")

    run([npm, "run", "typecheck"], EXTENSION_DIR)
    if not skip_tests:
        run([npm, "run", "test:extension-smoke"], EXTENSION_DIR)
    run([npm, "run", "build"], EXTENSION_DIR)
    run([npm, "run", "zip"], EXTENSION_DIR)

    if not skip_tests:
        run([cargo, "test"], NATIVE_DIR)
    run([cargo, "build", "--release"], NATIVE_DIR)


def package_release(version: str, output_dir: Path, skip_build: bool, skip_tests: bool) -> dict[str, str]:
    manifest_version = read_manifest_version()
    extension_version = read_extension_version()
    native_version = read_cargo_version()
    versions = {
        "requested": version,
        "extension_package": extension_version,
        "extension_manifest": manifest_version,
        "native_host": native_version,
    }
    mismatches = {name: value for name, value in versions.items() if value != version}
    if mismatches:
        raise RuntimeError(f"Version mismatch: {mismatches}")

    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = output_dir.resolve()

    build(skip_build=skip_build, skip_tests=skip_tests)

    package_name = f"brosdk-assistant-v{version}-windows"
    package_dir = output_dir / package_name
    staging_dir = output_dir / ".staging" / package_name

    remove_tree(staging_dir, output_dir)
    staging_dir.mkdir(parents=True)

    copy_tree(EXTENSION_DIR / "dist" / "chrome-mv3", staging_dir / "extension" / "chrome-mv3")
    copy_file(
        NATIVE_DIR / "target" / "release" / "brosdk-assistant-native.exe",
        staging_dir / "native-host" / "target" / "release" / "brosdk-assistant-native.exe",
    )
    copy_file(NATIVE_DIR / "scripts" / "install-windows.ps1", staging_dir / "native-host" / "scripts" / "install-windows.ps1")
    copy_file(NATIVE_DIR / "scripts" / "uninstall-windows.ps1", staging_dir / "native-host" / "scripts" / "uninstall-windows.ps1")
    copy_file(ROOT / "README.md", staging_dir / "README.md")
    for release_document in ["CHANGELOG.md", "LICENSE", "PRIVACY.md", "SECURITY.md"]:
        source = ROOT / release_document
        if source.exists():
            copy_file(source, staging_dir / release_document)
    if (ROOT / "docs").exists():
        copy_tree(ROOT / "docs", staging_dir / "docs")
    write_install_notes(staging_dir / "INSTALL-WINDOWS.txt", version)

    remove_tree(package_dir, output_dir)
    staging_dir.replace(package_dir)

    extension_zip = find_extension_zip(version)
    extension_asset = output_dir / f"brosdk-assistant-extension-v{version}-chrome.zip"
    copy_file(extension_zip, extension_asset)

    package_zip = zip_directory(package_dir, output_dir / f"{package_name}.zip", output_dir)

    manifest = {
        "version": version,
        "windows_package": package_zip.name,
        "windows_package_sha256": sha256(package_zip),
        "extension_zip": extension_asset.name,
        "extension_zip_sha256": sha256(extension_asset),
    }
    (output_dir / f"{package_name}.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output_dir / "SHA256SUMS.txt").write_text(
        f"{manifest['windows_package_sha256']}  {package_zip.name}\n"
        f"{manifest['extension_zip_sha256']}  {extension_asset.name}\n",
        encoding="utf-8",
    )
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build and package a Windows release.")
    parser.add_argument("--version", default=read_extension_version(), help="Release version. Defaults to extension/package.json.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Release output directory.")
    parser.add_argument("--skip-build", action="store_true", help="Only package existing build outputs.")
    parser.add_argument(
        "--skip-tests",
        action="store_true",
        help="Skip the Chrome extension smoke test and cargo test while building.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = package_release(
            version=args.version,
            output_dir=args.output_dir,
            skip_build=args.skip_build,
            skip_tests=args.skip_tests,
        )
    except subprocess.CalledProcessError as exc:
        print(f"Command failed with exit code {exc.returncode}: {' '.join(exc.cmd)}", file=sys.stderr)
        return exc.returncode
    except Exception as exc:
        print(f"Packaging failed: {exc}", file=sys.stderr)
        return 1

    print("\nRelease artifacts:")
    output_dir = args.output_dir.resolve()
    print(f"  Windows package: {output_dir / manifest['windows_package']}")
    print(f"  SHA256: {manifest['windows_package_sha256']}")
    print(f"  Extension zip: {output_dir / manifest['extension_zip']}")
    print(f"  SHA256: {manifest['extension_zip_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
