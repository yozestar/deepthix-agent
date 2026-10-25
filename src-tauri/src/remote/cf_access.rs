//! Defence in depth behind Cloudflare Access: every WebSocket upgrade must
//! carry the `Cf-Access-Jwt-Assertion` header Cloudflare adds after login.
//! We verify its signature (team JWKS), audience, issuer, expiry and email.

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};

pub const JWT_HEADER: &str = "cf-access-jwt-assertion";

#[derive(serde::Deserialize)]
struct Claims {
    email: String,
}

/// Returns the authenticated email when the token is valid for this team,
/// this application and the allowed email.
pub fn verify_with_jwks(
    token: &str,
    jwks: &JwkSet,
    team_domain: &str,
    aud: &str,
    allowed_email: &str,
) -> Result<String, String> {
    if allowed_email.trim().is_empty() || aud.is_empty() || team_domain.is_empty() {
        return Err("cloudflare access not configured".into());
    }
    let header = decode_header(token).map_err(|e| format!("bad jwt header: {e}"))?;
    let kid = header.kid.ok_or("jwt without kid")?;
    let jwk = jwks.find(&kid).ok_or("unknown jwt key")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|e| format!("bad jwk: {e}"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[aud]);
    validation.set_issuer(&[format!("https://{team_domain}")]);
    let data = decode::<Claims>(token, &key, &validation).map_err(|e| format!("jwt rejected: {e}"))?;
    if !data.claims.email.eq_ignore_ascii_case(allowed_email.trim()) {
        return Err("email not allowed".into());
    }
    Ok(data.claims.email)
}

#[cfg(test)]
pub(crate) mod test_support {
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    pub const TEAM: &str = "elyone.cloudflareaccess.com";
    pub const AUD: &str = "test-aud";
    pub const EMAIL: &str = "owner@example.com";

    pub fn jwks() -> jsonwebtoken::jwk::JwkSet {
        serde_json::from_str(include_str!("testdata/test_jwks.json")).unwrap()
    }

    pub fn sign(aud: &str, email: &str, iss: &str, exp_offset_s: i64) -> String {
        let now = chrono::Utc::now().timestamp();
        let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some("test-kid".into());
        let key = EncodingKey::from_rsa_pem(include_bytes!("testdata/test_rsa.pem")).unwrap();
        let claims = json!({ "aud": [aud], "email": email, "iss": iss, "exp": now + exp_offset_s, "iat": now });
        encode(&header, &claims, &key).unwrap()
    }

    pub fn valid() -> String {
        sign(AUD, EMAIL, &format!("https://{TEAM}"), 300)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn check(token: &str) -> Result<String, String> {
        verify_with_jwks(token, &jwks(), TEAM, AUD, EMAIL)
    }

    #[test]
    fn valid_jwt_returns_email() {
        assert_eq!(check(&valid()), Ok(EMAIL.to_string()));
    }

    #[test]
    fn cf_jwt_wrong_aud_rejected() {
        assert!(check(&sign("other-aud", EMAIL, &format!("https://{TEAM}"), 300)).is_err());
    }

    #[test]
    fn cf_jwt_wrong_email_rejected() {
        assert!(check(&sign(AUD, "intruder@example.com", &format!("https://{TEAM}"), 300)).is_err());
    }

    #[test]
    fn cf_jwt_wrong_issuer_rejected() {
        assert!(check(&sign(AUD, EMAIL, "https://evil.cloudflareaccess.com", 300)).is_err());
    }

    #[test]
    fn cf_jwt_expired_rejected() {
        assert!(check(&sign(AUD, EMAIL, &format!("https://{TEAM}"), -600)).is_err());
    }

    #[test]
    fn garbage_rejected() {
        assert!(check("not.a.jwt").is_err());
        assert!(check("").is_err());
    }

    #[test]
    fn empty_allowed_email_rejects_everything() {
        assert!(verify_with_jwks(&valid(), &jwks(), TEAM, AUD, "").is_err());
    }

    #[test]
    fn email_match_is_case_insensitive() {
        assert!(verify_with_jwks(&valid(), &jwks(), TEAM, AUD, "OWNER@example.com").is_ok());
    }
}
