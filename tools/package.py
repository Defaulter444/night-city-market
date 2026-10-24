"""Build a Foundry-installable release without world data or local tools."""
from pathlib import Path
import hashlib, json, sys, zipfile

root=Path(__file__).resolve().parents[1]
metadata=json.loads((root/'module.json').read_text(encoding='utf8'))
# --preview: test channel served from the development branch; that ZIP embeds the preview manifest.
PREVIEW='--preview' in sys.argv
PREVIEW_URL='https://raw.githubusercontent.com/Defaulter444/night-city-market/refs/heads/claude/pensive-rubin-8opsg3/distribution/preview/'
assert metadata['id']=='night-city-market'
assert metadata['manifest'].endswith('/releases/latest/download/module.json')
assert metadata['download'].endswith(f"/releases/download/v{metadata['version']}/night-city-market.zip")
assert metadata['compatibility']['maximum']=='12'
for name in metadata['esmodules']+metadata['styles']+[lang['path'] for lang in metadata['languages']]:
    assert (root/name).is_file(),name
for p in (root/'lang').glob('*.json'):json.loads(p.read_text(encoding='utf8'))

files=[root/name for name in ['module.json','README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md']]
for directory in ['scripts','vendor','styles','assets','lang','docs']:
    files.extend(p for p in (root/directory).rglob('*') if p.is_file())
assert all(p.resolve().is_relative_to(root) for p in files)
assert not any(p.suffix.lower() in {'.log','.db','.zip','.lock'} for p in files)
dist=root/'distribution'/'preview' if PREVIEW else root/'dist';dist.mkdir(parents=True,exist_ok=True)
manifest_bytes=(json.dumps(metadata|{'manifest':PREVIEW_URL+'module.json','download':PREVIEW_URL+'night-city-market.zip'},ensure_ascii=False,indent=2)+'\n').encode('utf8') if PREVIEW else (root/'module.json').read_bytes()
read=lambda p:manifest_bytes if p==root/'module.json' else p.read_bytes()
archive=dist/'night-city-market.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as package:
    for p in sorted(files):
        # Fixed timestamps make identical source produce an identical release ZIP.
        entry=zipfile.ZipInfo(p.relative_to(root).as_posix(),(2026,9,22,0,0,0))
        entry.compress_type=zipfile.ZIP_DEFLATED
        entry.external_attr=0o644<<16
        package.writestr(entry,read(p))
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    assert package.read('module.json')==manifest_bytes
    for p in files:assert package.read(p.relative_to(root).as_posix())==read(p)
(dist/'module.json').write_bytes(manifest_bytes)
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(dist/'SHA256SUMS.txt').write_text(f'{digest}  night-city-market.zip\n',encoding='utf8')
print(json.dumps({'version':metadata['version'],'files':len(files),'bytes':archive.stat().st_size,'sha256':digest},indent=2))
