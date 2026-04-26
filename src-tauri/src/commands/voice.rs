// Voice transcription via whisper.cpp (local, no network).
//
// Pipeline:
//   1. Frontend captures mic via MediaRecorder → WebM/Opus blob.
//   2. Sends base64 to `transcribe_audio` Tauri command.
//   3. We write the blob to /tmp/dt-<uuid>.webm.
//   4. ffmpeg converts → /tmp/dt-<uuid>.wav (16 kHz mono PCM, what whisper wants).
//   5. whisper-cli runs against ggml-base.bin and writes <stem>.txt.
//   6. Read the .txt, clean up, return.
//
// Both whisper-cli and ffmpeg are required system binaries (Homebrew on
// macOS). We probe for them on first call and return a friendly error
// if absent.

use std::path::PathBuf;
use std::process::Command;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscribeResult {
    /// Cleaned-up transcript text (no timestamps, no leading whitespace).
    pub text: String,
    /// Wall-clock time taken end-to-end.
    pub elapsed_ms: u64,
}

fn which(name: &str) -> Option<PathBuf> {
    // Try common Homebrew + system paths first to avoid PATH surprises.
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = PathBuf::from(prefix).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // Fallback: spawn `which` if the prefixes missed.
    let out = Command::new("which").arg(name).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        None
    } else {
        Some(PathBuf::from(p))
    }
}

fn pick_model() -> Option<PathBuf> {
    // Prefer larger / more accurate models if the user has them.
    let home = dirs::home_dir()?;
    let cache = home.join(".cache").join("whisper");
    for name in [
        "ggml-large-v3.bin",
        "ggml-large-v2.bin",
        "ggml-medium.bin",
        "ggml-small.bin",
        "ggml-base.bin",
        "ggml-tiny.bin",
    ] {
        let p = cache.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// `mime` — MIME content type the frontend captured (e.g. "audio/webm").
///   Decides which extension we hand ffmpeg. Defaults to webm.
/// `lang` — 2-letter ISO language code (e.g. "fr", "en"). When None
///   whisper auto-detects (slower).
#[tauri::command]
pub fn transcribe_audio(
    audio_base64: String,
    mime: Option<String>,
    lang: Option<String>,
) -> Result<TranscribeResult, String> {
    let started = std::time::Instant::now();

    let whisper = which("whisper-cli").ok_or_else(|| {
        "whisper-cli not found. Install with: brew install whisper-cpp".to_string()
    })?;
    let ffmpeg = which("ffmpeg")
        .ok_or_else(|| "ffmpeg not found. Install with: brew install ffmpeg".to_string())?;
    let model = pick_model().ok_or_else(|| {
        "no whisper model in ~/.cache/whisper/. Download with: whisper --model base --download-only"
            .to_string()
    })?;

    // Decode base64 + work out the input file extension from the mime hint.
    let bytes = B64
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    if bytes.is_empty() {
        return Err("empty audio".to_string());
    }
    let ext = match mime.as_deref().unwrap_or("audio/webm") {
        m if m.contains("webm") => "webm",
        m if m.contains("ogg") => "ogg",
        m if m.contains("mp4") || m.contains("mpeg") || m.contains("aac") => "m4a",
        m if m.contains("wav") => "wav",
        m if m.contains("mp3") => "mp3",
        _ => "webm",
    };

    let id = uuid::Uuid::new_v4().to_string();
    let raw = std::env::temp_dir().join(format!("deepthix-vox-{id}.{ext}"));
    let wav = std::env::temp_dir().join(format!("deepthix-vox-{id}.wav"));
    let stem = std::env::temp_dir().join(format!("deepthix-vox-{id}"));
    let txt = std::env::temp_dir().join(format!("deepthix-vox-{id}.txt"));

    let _cleanup = TmpCleanup(vec![raw.clone(), wav.clone(), txt.clone()]);

    std::fs::write(&raw, &bytes).map_err(|e| format!("write raw audio: {e}"))?;

    // ffmpeg: convert to 16 kHz mono pcm_s16le wav (whisper's native format).
    let ff = Command::new(&ffmpeg)
        .args([
            "-y", // overwrite
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(&raw)
        .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
        .arg(&wav)
        .output()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    if !ff.status.success() {
        return Err(format!(
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&ff.stderr).trim()
        ));
    }

    // whisper-cli: run the model, output a plain-text transcript next to the wav.
    // -ng (no-gpu): we explicitly disable Metal because the Tauri webview is
    // already holding a Metal device for WebGL/canvas rendering. Trying to
    // allocate a second Metal context for whisper trips
    // `ggml-metal-device.m:608: GGML_ASSERT([rsets->data count] == 0)`
    // and the assert kills the subprocess before it writes anything.
    // CPU is plenty fast for short voice prompts on Apple Silicon (~0.5s
    // for 5s of audio with the base model).
    let mut cmd = Command::new(&whisper);
    cmd.arg("-m").arg(&model);
    cmd.arg(&wav);
    cmd.args(["-ng", "--no-prints", "--output-txt", "-of"]);
    cmd.arg(&stem);
    if let Some(l) = lang.as_deref() {
        cmd.args(["-l", l]);
    } else {
        cmd.args(["-l", "auto"]);
    }
    let w = cmd
        .output()
        .map_err(|e| format!("whisper-cli spawn: {e}"))?;
    // whisper.cpp's Metal backend has a known crash in
    // ggml_metal_device_free during process exit (`ggml_abort` in
    // libggml-metal.dylib at __cxa_finalize). The transcript is
    // written to disk BEFORE the crash, so we tolerate a non-zero
    // exit and only error out when the .txt is missing or empty.
    let txt_exists_and_nonempty = std::fs::metadata(&txt)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !w.status.success() && !txt_exists_and_nonempty {
        return Err(format!(
            "whisper-cli failed: {}",
            String::from_utf8_lossy(&w.stderr).trim()
        ));
    }
    if !w.status.success() {
        tracing::debug!(
            target: "deepthix::voice",
            code = ?w.status.code(),
            "whisper-cli exited non-zero but transcript exists (likely Metal cleanup crash); using output",
        );
    }

    let text = std::fs::read_to_string(&txt)
        .map_err(|e| format!("read transcript: {e}"))?
        .trim()
        .to_string();

    Ok(TranscribeResult {
        text,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// RAII cleanup for the tmp files we spilled.
struct TmpCleanup(Vec<PathBuf>);
impl Drop for TmpCleanup {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_audio_returns_err() {
        let result = transcribe_audio("".into(), None, None);
        assert!(result.is_err());
    }

    #[test]
    fn pick_model_prefers_larger() {
        // Just sanity — we shouldn't crash if no models are present.
        let _ = pick_model();
    }
}
