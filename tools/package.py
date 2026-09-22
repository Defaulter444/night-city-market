"""Build a Foundry-installable release without world data or local tools."""
from pathlib import Path
import hashlib, json, zipfile

root=Path(__file__).resolve().parents[1]
metadata=json.loads((root/'module.json').read_text(encoding='utf8'))
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
dist=root/'dist';dist.mkdir(exist_ok=True)
archive=dist/'night-city-market.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as package:
    for p in sorted(files):
        # Fixed timestamps make identical source produce an identical release ZIP.
        entry=zipfile.ZipInfo(p.relative_to(root).as_posix(),(2026,9,22,0,0,0))
        entry.compress_type=zipfile.ZIP_DEFLATED
        entry.external_attr=0o644<<16
        package.writestr(entry,p.read_bytes())
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    assert package.read('module.json')==(root/'module.json').read_bytes()
    for p in files:assert package.read(p.relative_to(root).as_posix())==p.read_bytes()
(dist/'module.json').write_bytes((root/'module.json').read_bytes())
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(dist/'SHA256SUMS.txt').write_text(f'{digest}  night-city-market.zip\n',encoding='utf8')
print(json.dumps({'version':metadata['version'],'files':len(files),'bytes':archive.stat().st_size,'sha256':digest},indent=2))
