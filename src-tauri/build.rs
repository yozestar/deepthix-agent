fn main() {
  // The manifest (Common Controls v6) is embedded by the linker for EVERY
  // target instead of by tauri_build for bins only: the tauri `test`
  // feature (mock runtime, used by remote:: tests) needs it too, otherwise
  // the lib test binary dies at load with STATUS_ENTRYPOINT_NOT_FOUND.
  // Content is identical to tauri_build's default manifest.
  #[cfg(windows)]
  let attributes = {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
    tauri_build::Attributes::new()
      .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
  };
  #[cfg(not(windows))]
  let attributes = tauri_build::Attributes::new();
  tauri_build::try_build(attributes).expect("tauri build");
}
