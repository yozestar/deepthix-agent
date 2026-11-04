// Same check as tauri-plugin-updater: base64(minisign pubkey) from
// tauri.conf.json, base64(minisign signature) from the .sig file.
use base64::Engine;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_txt = String::from_utf8(b64.decode(a[1].trim()).unwrap()).unwrap();
    let pk = minisign_verify::PublicKey::decode(&pk_txt).unwrap();
    let sig_txt = String::from_utf8(b64.decode(std::fs::read_to_string(&a[3]).unwrap().trim()).unwrap()).unwrap();
    let sig = minisign_verify::Signature::decode(&sig_txt).unwrap();
    let data = std::fs::read(&a[2]).unwrap();
    match pk.verify(&data, &sig, true) {
        Ok(()) => println!("SIGNATURE VALIDE  {}", a[2]),
        Err(e) => println!("SIGNATURE INVALIDE {}: {e}", a[2]),
    }
}
