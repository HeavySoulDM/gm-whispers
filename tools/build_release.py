"""Сборка чистого релиза GM Whispers в отдельную папку (прод-билд).

    python tools/build_release.py [--out H:\\Cowork\\GM_Whispers_Release]

Что делает:
- копирует модуль и сервер БЕЗ личных данных: .env, data/, .venv, __pycache__, тестовые выгрузки, профиль
  кампании и словари заменяются пустыми образцами;
- проверяет, что версии module.json и server/gmw/__init__.py совпадают;
- подставляет в module.json ссылки manifest/download/url из tools/release.json (если заполнено);
- кладёт zip модуля (gm-whispers-v<версия>.zip), zip сервера, module.json отдельно (для ссылки на манифест),
  README для пользователей и файл CHECKSUMS.txt;
- печатает, что проверить руками перед публикацией.

Папка назначения очищается и создаётся заново: это всегда свежая сборка, не рабочая копия.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_ID = "gm-whispers"

# Что НЕ попадает в релиз сервера.
SERVER_EXCLUDE_DIRS = {".venv", "__pycache__", "data", "dist", "build"}
SERVER_EXCLUDE_FILES = {".env", "gmw_core.spec"}  # spec — для сборки exe, пользователю не нужен
# Личные конфиги → пустые образцы.
CONFIG_TEMPLATES = {
    "campaign.json": {"name": "", "system": "", "description": "", "tone": "", "special_rules": "", "lang": "auto",
                      "answer_length": "normal", "lines_only": "0", "no_improv": "0", "player_names": "0"},
    "speakers.json": {"_comment": "Кто есть кто в записи Craig: ник → подпись. Заполняется в Foundry: ⚙ Настройки сервера → Голос."},
    "ignore.json": {"_comment": "Что не учитывать в итогах. Заполняется в Foundry: ⚙ Настройки сервера → Голос.", "voice": ["kenku"], "chat": []},
}
TOOLS_INCLUDE = {"autostart.bat", "download_model.bat", "link_module.bat"}


def read_version() -> str:
    mod = json.loads((ROOT / "foundry-module" / MODULE_ID / "module.json").read_text(encoding="utf-8"))
    init = (ROOT / "server" / "gmw" / "__init__.py").read_text(encoding="utf-8")
    srv = re.search(r'__version__\s*=\s*"([^"]+)"', init)
    if not srv or srv.group(1) != mod["version"]:
        sys.exit(f"Версии расходятся: module.json={mod['version']} server={srv.group(1) if srv else '?'}. Поправь перед сборкой.")
    return mod["version"]


def copytree(src: Path, dst: Path, skip_dirs=(), skip_files=()):
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        if any(part in skip_dirs for part in rel.parts):
            continue
        if p.is_dir():
            continue
        if p.name in skip_files or p.suffix in (".pyc", ".log", ".tmp", ".bak"):
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)


def zip_dir(folder: Path, zip_path: Path, arc_root: str) -> None:
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(folder.rglob("*")):
            if p.is_file():
                z.write(p, f"{arc_root}/{p.relative_to(folder).as_posix()}")


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT.parent / "GM_Whispers_Release"))
    args = ap.parse_args()
    out = Path(args.out)
    version = read_version()
    release_cfg = {}
    cfg_path = ROOT / "tools" / "release.json"
    if cfg_path.exists():
        release_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    repo = (release_cfg.get("repo") or "").strip().rstrip("/")
    if repo and not repo.startswith("http"):
        repo = "https://github.com/" + repo  # допустимо и «владелец/репозиторий»

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    warnings: list[str] = []

    # --- модуль
    mod_src = ROOT / "foundry-module" / MODULE_ID
    mod_dst = out / "module" / MODULE_ID
    copytree(mod_src, mod_dst)
    manifest = json.loads((mod_dst / "module.json").read_text(encoding="utf-8"))
    if repo:
        manifest["url"] = repo
        manifest["manifest"] = f"{repo}/releases/latest/download/module.json"
        manifest["download"] = f"{repo}/releases/download/v{version}/{MODULE_ID}-v{version}.zip"
        manifest["readme"] = f"{repo}#readme"
        manifest["changelog"] = f"{repo}/releases"
        manifest["bugs"] = f"{repo}/issues"
    else:
        warnings.append("tools/release.json: не задан repo — в module.json нет ссылок manifest/download, установка по ссылке не заработает.")
    if not manifest.get("license"):
        manifest["license"] = "LICENSE"
    (mod_dst / "module.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name in ("LICENSE", "README.md"):
        src = ROOT / name
        if src.exists() and name == "LICENSE":
            shutil.copy2(src, mod_dst / name)
    if not (ROOT / "LICENSE").exists():
        warnings.append("Нет файла LICENSE в корне проекта — добавь перед публикацией.")
    zip_dir(mod_dst, out / f"{MODULE_ID}-v{version}.zip", MODULE_ID)
    shutil.copy2(mod_dst / "module.json", out / "module.json")

    # --- сервер
    srv_src = ROOT / "server"
    srv_dst = out / "GM_Whispers_Core" / "server"
    copytree(srv_src, srv_dst, skip_dirs=SERVER_EXCLUDE_DIRS, skip_files=SERVER_EXCLUDE_FILES)
    for name, tpl in CONFIG_TEMPLATES.items():
        (srv_dst / "config" / name).write_text(json.dumps(tpl, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # eval.json — пример с пометкой
    ev = srv_dst / "config" / "eval.json"
    if ev.exists():
        data = json.loads(ev.read_text(encoding="utf-8"))
        data["_comment"] = "Пример контрольного набора (кампания Dungeons of Drakkenheim). Замени вопросы на свои: q — вопрос, expect — часть названия страницы с ответом. Запуск: eval.bat"
        ev.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tools_dst = out / "GM_Whispers_Core" / "tools"
    tools_dst.mkdir(parents=True, exist_ok=True)
    for name in TOOLS_INCLUDE:
        src = ROOT / "tools" / name
        if src.exists():
            shutil.copy2(src, tools_dst / name)
    for name in ("LICENSE",):
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, out / "GM_Whispers_Core" / name)
    user_readme = ROOT / "docs" / "README_USER.md"
    if user_readme.exists():
        shutil.copy2(user_readme, out / "GM_Whispers_Core" / "README.md")
        shutil.copy2(user_readme, out / "README.md")
    else:
        warnings.append("Нет docs/README_USER.md — в релизе нет инструкции для пользователей.")
    zip_dir(out / "GM_Whispers_Core", out / f"GM_Whispers_Core-v{version}.zip", "GM_Whispers_Core")

    # --- проверка на личные данные
    leaks = []
    for p in out.rglob("*"):
        if p.is_file() and p.suffix in (".py", ".js", ".json", ".md", ".bat", ".vbs", ".example", ".txt", ".css"):
            txt = p.read_text(encoding="utf-8", errors="ignore")
            for pat in (r"sk-ant-[A-Za-z0-9_-]{10,}", r"sk-[A-Za-z0-9_-]{20,}", r"AIza[0-9A-Za-z_-]{30,}", r"H:\\\\Cowork", r"heavy4soul"):
                if re.search(pat, txt):
                    leaks.append(f"{p.relative_to(out)}: {pat}")
    if leaks:
        warnings.append("Похоже на личные данные в релизе:\n   " + "\n   ".join(leaks))

    # --- контрольные суммы и отчёт
    sums = [f"{sha256(z)}  {z.name}" for z in sorted(out.glob("*.zip"))]
    (out / "CHECKSUMS.txt").write_text("\n".join(sums) + "\n", encoding="utf-8")
    print(f"Релиз v{version} собран в {out}")
    for z in sorted(out.glob("*.zip")):
        print(f"  {z.name}  {z.stat().st_size // 1024} КБ")
    if warnings:
        print("\nПроверь перед публикацией:")
        for w in warnings:
            print(f" - {w}")
    print("\nДальше: создать релиз на GitHub с тегом v{0}, приложить оба zip и module.json.".format(version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
