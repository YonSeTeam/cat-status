"""Packs the mod into dist/cat-status.zip, the archive friends install from.

Only the files the engine needs go in; the server, scripts and the files Claude
Code writes itself (.claude-plugin/types, tsconfig.json) stay out.

    python scripts/pack-zip.py [output.zip]
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCLUDE = ['.claude-plugin/plugin.json', 'hooks', 'types']

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'cat-status.zip')
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            z.write(path, 'cat-status/' + item)
            continue
        for d, _, files in os.walk(path):
            for f in files:
                full = os.path.join(d, f)
                rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
                z.write(full, 'cat-status/' + rel)

print(out)
for name in zipfile.ZipFile(out).namelist():
    print('  ' + name)
