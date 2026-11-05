"""Publish a release of Elyone AI Desktop Agent to dev.elyone.com/agent/.

    python3 -I publish.py <version> [--dry-run]

Inputs in ~/Desktop/.release/out/ :
  Elyone-AI-Desktop-Agent_<v>_macOS-AppleSilicon.dmg          (download page)
  Elyone-AI-Desktop-Agent_<v>_aarch64.app.tar.gz (+ .sig)       (Mac update)
  Elyone-AI-Desktop-Agent_<v>_arm64-setup.exe / _x64-setup.exe  (page + update)

The Windows installers are signed here (the key never leaves this Mac:
~/.tauri/elyone-agent-updater.key, password in the Keychain under
'elyone-agent-updater-key'). Then latest.json + the download page are
generated, everything is uploaded, checked by sha256 on the server, and the
public URLs are tested.
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

V = sys.argv[1]
DRY = '--dry-run' in sys.argv
HOME = os.path.expanduser('~')
OUT = f'{HOME}/Desktop/.release/out'
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = f'{HOME}/Documents/Dev/claude_agent-release'
KEY = f'{HOME}/.tauri/elyone-agent-updater.key'
SSH = ['ssh', '-i', f'{HOME}/.ssh/id_ed25519', '-o', 'BatchMode=yes', 'johann@dev.elyone.com']
SCP = ['scp', '-q', '-i', f'{HOME}/.ssh/id_ed25519', '-o', 'BatchMode=yes']
WWW = '/var/www/agent-downloads'
BASE = 'https://dev.elyone.com/agent'
AUTH = 'elyone:ElyoneAgent2026'

N = f'Elyone-AI-Desktop-Agent_{V}'
files = {
    'dmg': f'{N}_macOS-AppleSilicon.dmg',
    'mac_upd': f'{N}_aarch64.app.tar.gz',
    'arm64': f'{N}_arm64-setup.exe',
    'x64': f'{N}_x64-setup.exe',
}
for k, f in files.items():
    if not os.path.exists(f'{OUT}/{f}'):
        sys.exit(f'manquant : {f}')


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


# 1. sign the Windows installers (Mac archive was signed by the build)
pw = subprocess.run(['security', 'find-generic-password', '-a', 'elyone', '-s',
                     'elyone-agent-updater-key', '-w'], capture_output=True, text=True, check=True).stdout.strip()
for k in ('arm64', 'x64'):
    f = f'{OUT}/{files[k]}'
    if not os.path.exists(f + '.sig'):
        r = subprocess.run(['npx', 'tauri', 'signer', 'sign', '-f', KEY, '-p', pw, f],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(f + '.sig'):
            sys.exit(f'signature impossible pour {files[k]}: {r.stderr[-400:]}')
print('signatures : ok')

sig = {k: open(f'{OUT}/{files[k]}.sig').read().strip() for k in ('mac_upd', 'arm64', 'x64')}

# 2. latest.json (read by the app's updater)
notes = open(f'{HERE}/notes/{V}.txt').read().strip() if os.path.exists(f'{HERE}/notes/{V}.txt') else f'Version {V}'
latest = {
    'version': V,
    'notes': notes,
    'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {
        'darwin-aarch64': {'signature': sig['mac_upd'], 'url': f"{BASE}/updates/{files['mac_upd']}"},
        'windows-aarch64': {'signature': sig['arm64'], 'url': f"{BASE}/updates/{files['arm64']}"},
        'windows-x86_64': {'signature': sig['x64'], 'url': f"{BASE}/updates/{files['x64']}"},
    },
}
json.dump(latest, open(f'{OUT}/latest.json', 'w'), indent=2, ensure_ascii=False)

# 3. download page: same page, new links + version line
page = open(f'{HERE}/index.current.html', encoding='utf-8').read()
page = re.sub(r'<p class="version">[^<]*</p>', f'<p class="version">Version {V} · Mac et Windows</p>', page)
page = re.sub(r'Elyone-AI-Desktop-Agent_[0-9.]+_(x64-setup\.exe|arm64-setup\.exe|macOS-AppleSilicon\.dmg)',
              lambda m: f'{N}_{m.group(1)}', page)
upd_note = ('Mises à jour : à partir de la version 0.6.12, l&#39;application se met à jour toute seule '
            '(bandeau « Nouvelle version disponible » en haut de la fenêtre, puis « Installer et redémarrer »). '
            'Cette page ne sert plus que pour une première installation.<br>\n  ')
if 'se met à jour toute seule' not in page:
    page = page.replace('<p class="note">', '<p class="note">' + upd_note, 1)
open(f'{OUT}/index.html', 'w', encoding='utf-8').write(page)
with open(f'{OUT}/SHA256SUMS.txt', 'w') as fh:
    for k in ('x64', 'arm64', 'dmg'):
        fh.write(f"{sha(f'{OUT}/{files[k]}')}  {files[k]}\n")
upd_sums = ''.join(f"{sha(f'{OUT}/{files[k]}')}  {files[k]}\n" for k in ('mac_upd', 'arm64', 'x64'))
open(f'{OUT}/SHA256SUMS.updates.txt', 'w').write(upd_sums)
print('latest.json, index.html, SHA256SUMS : prêts')
if DRY:
    print(json.dumps(latest, indent=1)[:600])
    sys.exit(0)

# 4. upload to a temp dir, verify, then install (page last, after the files)
tmp = f'/tmp/agent-release-{V}'
subprocess.run(SSH + [f'rm -rf {tmp} && mkdir -p {tmp}'], check=True)
up = [f'{OUT}/{files[k]}' for k in files] + [f'{OUT}/{files[k]}.sig' for k in ('mac_upd', 'arm64', 'x64')] + \
     [f'{OUT}/latest.json', f'{OUT}/index.html', f'{OUT}/SHA256SUMS.txt', f'{OUT}/SHA256SUMS.updates.txt']
subprocess.run(SCP + up + [f'johann@dev.elyone.com:{tmp}/'], check=True)
remote = f"""set -e; cd {tmp}
sha256sum -c SHA256SUMS.txt; sha256sum -c SHA256SUMS.updates.txt
sudo mkdir -p {WWW}/updates
sudo cp {files['dmg']} {files['arm64']} {files['x64']} {WWW}/
sudo cp {files['mac_upd']} {files['mac_upd']}.sig {files['arm64']} {files['arm64']}.sig {files['x64']} {files['x64']}.sig {WWW}/updates/
sudo cp {WWW}/index.html {WWW}/index.html.bak-avant-{V} 2>/dev/null || true
sudo cp latest.json {WWW}/updates/latest.json
sudo cp index.html SHA256SUMS.txt {WWW}/
sudo chown -R root:www-data {WWW}; sudo find {WWW} -type d -exec chmod 755 {{}} +; sudo find {WWW} -type f -exec chmod 644 {{}} +
rm -rf {tmp}"""
subprocess.run(SSH + [remote], check=True)
print('serveur : fichiers en place')

# 5. check what the app and the browser will see
def code(url, auth=True):
    a = ['-u', AUTH] if auth else []
    return subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}'] + a + [url],
                          capture_output=True, text=True).stdout


print('latest.json sans mot de passe :', code(f'{BASE}/updates/latest.json', auth=False), '(attendu 401)')
print('latest.json avec mot de passe :', code(f'{BASE}/updates/latest.json'))
for k in ('mac_upd', 'arm64', 'x64'):
    print(f"{files[k]} :", code(f"{BASE}/updates/{files[k]}"))
print('page :', code(f'{BASE}/'))
