// Computes Elyone project ids exactly like `state::project_id_for_path`
// (DefaultHasher over `path.to_string_lossy()`).
// Usage: project_ids <utf8-file-with-one-path-per-line>
// Output: `<id>\t<path>` per line, same order as the input.
use std::hash::{Hash, Hasher};

fn main() {
    let file = std::env::args().nth(1).expect("usage: project_ids <paths-file>");
    let text = std::fs::read_to_string(&file).expect("read paths file");
    let text = text.trim_start_matches('\u{feff}');
    for line in text.lines() {
        let path = line.trim_end_matches('\r');
        if path.is_empty() {
            continue;
        }
        let lossy = std::path::Path::new(path).to_string_lossy().to_string();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        lossy.hash(&mut hasher);
        println!("{:x}\t{}", hasher.finish(), path);
    }
}
