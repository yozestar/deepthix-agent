//! Web Push to paired devices (iOS home-screen web app included): RFC 8291
//! payload encryption (aes128gcm) + RFC 8292 VAPID identification, in pure
//! Rust crypto (no `ring`).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;

/// `PushSubscription.toJSON()` from the browser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

const RECORD_SIZE: u32 = 4096;

fn hkdf_expand(prk: &Hkdf<Sha256>, info: &[u8], len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    // Lengths used here (12/16/32) are always valid for SHA-256.
    prk.expand(info, &mut out).expect("hkdf length");
    out
}

/// Deterministic core (fixed server key + salt) — `encrypt` randomises both.
pub fn encrypt_with(
    plaintext: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    as_secret: &p256::SecretKey,
    salt: [u8; 16],
) -> Result<Vec<u8>, String> {
    let ua_key = p256::PublicKey::from_sec1_bytes(ua_public).map_err(|e| format!("bad p256dh: {e}"))?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_key.as_affine());

    let key_info = [b"WebPush: info\0".as_slice(), ua_public, as_public.as_bytes()].concat();
    let ikm = hkdf_expand(
        &Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes()),
        &key_info,
        32,
    );
    let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let cek = hkdf_expand(&prk, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf_expand(&prk, b"Content-Encoding: nonce\0", 12);

    // Single record: plaintext + 0x02 delimiter (last record, no padding).
    let mut record = plaintext.to_vec();
    record.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|e| e.to_string())?;

    let mut body = Vec::with_capacity(86 + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// Encrypts `plaintext` for `sub` with a fresh server key and salt.
pub fn encrypt(plaintext: &[u8], sub: &Subscription) -> Result<Vec<u8>, String> {
    use rand::RngCore;
    let ua_public = B64.decode(&sub.keys.p256dh).map_err(|e| format!("bad p256dh: {e}"))?;
    let auth = B64.decode(&sub.keys.auth).map_err(|e| format!("bad auth: {e}"))?;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let as_secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    encrypt_with(plaintext, &ua_public, &auth, &as_secret, salt)
}

/// ES256 JWT for the push service at `audience` (scheme + host of the endpoint).
pub fn vapid_jwt(key: &p256::SecretKey, audience: &str, subject: &str, exp: i64) -> String {
    use p256::ecdsa::signature::Signer;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(json!({ "aud": audience, "exp": exp, "sub": subject }).to_string());
    let signing_input = format!("{header}.{claims}");
    let signature: p256::ecdsa::Signature = SigningKey::from(key).sign(signing_input.as_bytes());
    format!("{signing_input}.{}", B64.encode(signature.to_bytes()))
}

/// Uncompressed public key, base64url — the browser's `applicationServerKey`.
pub fn vapid_public_key(key: &p256::SecretKey) -> String {
    B64.encode(key.public_key().to_encoded_point(false).as_bytes())
}

/// How long the push service keeps an undelivered message (seconds).
const PUSH_TTL_S: u32 = 3600;
const VAPID_VALIDITY_S: i64 = 12 * 3600;

/// Sends one notification; returns the push service's HTTP status.
pub async fn send(sub: &Subscription, key: &p256::SecretKey, subject: &str, payload: &[u8]) -> Result<u16, String> {
    let url = reqwest::Url::parse(&sub.endpoint).map_err(|e| format!("bad endpoint: {e}"))?;
    let audience = url.origin().ascii_serialization();
    let exp = chrono::Utc::now().timestamp() + VAPID_VALIDITY_S;
    let jwt = vapid_jwt(key, &audience, subject, exp);
    let body = encrypt(payload, sub)?;
    let res = reqwest::Client::new()
        .post(url)
        .header("Authorization", format!("vapid t={jwt}, k={}", vapid_public_key(key)))
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", PUSH_TTL_S.to_string())
        .header("Urgency", "high")
        .body(body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("push failed: {e}"))?;
    Ok(res.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s.split_whitespace().collect::<String>()).unwrap()
    }

    /// RFC 8291 §5 / Appendix A.
    #[test]
    fn encrypt_matches_rfc8291_test_vector() {
        let as_secret = p256::SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let plaintext = b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");

        let out = encrypt_with(&plaintext, &ua_public, &auth, &as_secret, salt).unwrap();

        let header = b64(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
             mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8",
        );
        let ciphertext = b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ");
        assert_eq!(header.len(), 86);
        assert_eq!(out, [header, ciphertext].concat());
    }

    #[test]
    fn vapid_jwt_has_expected_claims_and_valid_signature() {
        use p256::ecdsa::signature::Verifier;
        let key = p256::SecretKey::from_slice(&[7u8; 32]).unwrap();
        let jwt = vapid_jwt(&key, "https://web.push.apple.com", "mailto:owner@example.com", 1_900_000_000);
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&B64.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&B64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["typ"], "JWT");
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["sub"], "mailto:owner@example.com");
        assert_eq!(claims["exp"], 1_900_000_000);
        let sig = p256::ecdsa::Signature::from_slice(&B64.decode(parts[2]).unwrap()).unwrap();
        let vk = p256::ecdsa::VerifyingKey::from(key.public_key());
        vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).unwrap();
    }
}
