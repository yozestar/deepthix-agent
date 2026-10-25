//! Pending pairing requests: a new device asks, the owner accepts on the
//! PC (or on an already-paired device), the device receives its token.

use std::collections::HashMap;

use super::config::{hash_token, new_token, Device};

pub const PAIR_TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct PairRequest {
    pub id: String,
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PairOutcome {
    Accepted { token: String, device: Device },
    Denied,
}

#[derive(Default)]
pub struct PairingQueue {
    pending: HashMap<String, (PairRequest, i64)>,
}

impl PairingQueue {
    pub fn request(&mut self, name: String, now_ms: i64) -> PairRequest {
        use rand::Rng;
        self.pending.retain(|_, (_, at)| now_ms - *at <= PAIR_TTL_MS);
        let req = PairRequest {
            id: uuid::Uuid::new_v4().to_string(),
            code: format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000)),
            name,
        };
        self.pending.insert(req.id.clone(), (req.clone(), now_ms));
        req
    }

    /// `None` when the id is unknown, already answered, or expired.
    pub fn respond(&mut self, id: &str, accept: bool, now_ms: i64) -> Option<PairOutcome> {
        let (req, at) = self.pending.remove(id)?;
        if now_ms - at > PAIR_TTL_MS {
            return None;
        }
        if !accept {
            return Some(PairOutcome::Denied);
        }
        let token = new_token();
        let device = Device {
            id: uuid::Uuid::new_v4().to_string(),
            name: req.name,
            token_hash: hash_token(&token),
            paired_ms: now_ms,
            last_seen_ms: now_ms,
            push_subscription: None,
        };
        Some(PairOutcome::Accepted { token, device })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_has_six_digit_code() {
        let mut q = PairingQueue::default();
        let r = q.request("iPhone".into(), 0);
        assert_eq!(r.code.len(), 6);
        assert!(r.code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(r.name, "iPhone");
    }

    #[test]
    fn pair_accept_returns_token_once() {
        let mut q = PairingQueue::default();
        let r = q.request("iPhone".into(), 10);
        match q.respond(&r.id, true, 20) {
            Some(PairOutcome::Accepted { token, device }) => {
                assert_eq!(device.token_hash, hash_token(&token));
                assert_eq!(device.name, "iPhone");
                assert_eq!(device.paired_ms, 20);
            }
            other => panic!("expected Accepted, got {other:?}"),
        }
        assert_eq!(q.respond(&r.id, true, 21), None);
    }

    #[test]
    fn pair_reject_returns_denied() {
        let mut q = PairingQueue::default();
        let r = q.request("iPhone".into(), 0);
        assert_eq!(q.respond(&r.id, false, 1), Some(PairOutcome::Denied));
        assert_eq!(q.respond(&r.id, true, 2), None);
    }

    #[test]
    fn pair_expires_after_5_min() {
        let mut q = PairingQueue::default();
        let r = q.request("iPhone".into(), 0);
        assert_eq!(q.respond(&r.id, true, PAIR_TTL_MS + 1), None);
    }

    #[test]
    fn unknown_id_returns_none() {
        let mut q = PairingQueue::default();
        assert_eq!(q.respond("nope", true, 0), None);
    }
}
