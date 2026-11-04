# Publishing a version

1. Bump the version (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml), commit, write `notes/<version>.txt` (shown in the update banner).
2. Mac (signed): `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/elyone-agent-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a elyone -s elyone-agent-updater-key -w)" CI=true npx tauri build --bundles app,dmg`, then copy into `~/Desktop/.release/out/`:
   `Elyone-AI-Desktop-Agent_<v>_macOS-AppleSilicon.dmg`, `Elyone-AI-Desktop-Agent_<v>_aarch64.app.tar.gz` and its `.sig`.
3. Windows (on the VM, never launches claude): `git bundle create ~/Desktop/.release/agent.bundle HEAD`, copy `build-win.ps1` to `~/Desktop/.release/`, then
   `prlctl exec "Windows 11" --current-user powershell -NoProfile -ExecutionPolicy Bypass -File '\\Mac\Bureau\.release\build-win.ps1'`.
4. `python3 -I publish.py <v> --dry-run`, check, then `python3 -I publish.py <v>`. The Windows installers are signed on the Mac; the key never leaves it.
5. Optional: `cargo run --release --manifest-path sigcheck/Cargo.toml -- <pubkey> <file> <file>.sig`.

Signing key: `~/.tauri/elyone-agent-updater.key` (+ `.pub`), password in the macOS Keychain (`elyone-agent-updater-key`). Losing it means every install must be updated by hand once.
