//! WebSocket messages between a remote browser and the agent (JSON, `t` tag).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello { token: String },
    Pair { name: String },
    Invoke { id: u64, cmd: String, #[serde(default)] args: Value },
    PairRespond { id: String, accept: bool },
    PushSubscribe { subscription: crate::remote::webpush::Subscription },
    Disable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Ready,
    PairPending { code: String },
    Paired { token: String },
    PairDenied,
    Result {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        ok: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        err: Option<String>,
    },
    Event { name: String, payload: Value },
    Bye { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_invoke_without_args() {
        let m: ClientMsg = serde_json::from_value(json!({"t":"invoke","id":3,"cmd":"list_projects"})).unwrap();
        assert_eq!(m, ClientMsg::Invoke { id: 3, cmd: "list_projects".into(), args: Value::Null });
    }

    #[test]
    fn parses_hello_pair_disable_and_pair_respond() {
        let h: ClientMsg = serde_json::from_value(json!({"t":"hello","token":"x"})).unwrap();
        assert_eq!(h, ClientMsg::Hello { token: "x".into() });
        let p: ClientMsg = serde_json::from_value(json!({"t":"pair","name":"iPhone"})).unwrap();
        assert_eq!(p, ClientMsg::Pair { name: "iPhone".into() });
        let d: ClientMsg = serde_json::from_value(json!({"t":"disable"})).unwrap();
        assert_eq!(d, ClientMsg::Disable);
        let r: ClientMsg = serde_json::from_value(json!({"t":"pair_respond","id":"r1","accept":true})).unwrap();
        assert_eq!(r, ClientMsg::PairRespond { id: "r1".into(), accept: true });
    }

    #[test]
    fn result_omits_missing_side() {
        let ok = serde_json::to_value(ServerMsg::Result { id: 1, ok: Some(json!(5)), err: None }).unwrap();
        assert_eq!(ok, json!({"t":"result","id":1,"ok":5}));
        let err = serde_json::to_value(ServerMsg::Result { id: 2, ok: None, err: Some("no".into()) }).unwrap();
        assert_eq!(err, json!({"t":"result","id":2,"err":"no"}));
    }

    #[test]
    fn event_and_pair_pending_shape() {
        let e = serde_json::to_value(ServerMsg::Event { name: "pty_data".into(), payload: json!({"id":"a"}) }).unwrap();
        assert_eq!(e, json!({"t":"event","name":"pty_data","payload":{"id":"a"}}));
        let p = serde_json::to_value(ServerMsg::PairPending { code: "123456".into() }).unwrap();
        assert_eq!(p, json!({"t":"pair_pending","code":"123456"}));
    }
}
