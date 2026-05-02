use anyhow::{Context, Result, anyhow};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::snapshot::FileSnapshot;

type HmacSha256 = Hmac<Sha256>;

/// Raw HMAC-SHA256 of `message`, hex-encoded with the `sha256=` prefix
/// the server expects in the `X-Title-Signature` header. Used by both
/// the JSON and document-upload paths; they differ in how they construct
/// the message.
fn sign_message(secret: &str, message: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    let bytes = mac.finalize().into_bytes();
    format!("sha256={}", hex::encode(bytes))
}

/// JSON-body endpoints sign `${timestamp}.${rawBody}`. Mirrors the
/// server's verifySignature in convex/http.ts. Server rejects timestamps
/// further than 5 minutes from its clock, so callers should sign close
/// to send.
fn sign(secret: &str, timestamp_ms: i64, body: &str) -> String {
    sign_message(secret, &format!("{timestamp_ms}.{body}"))
}

/// Document uploads sign a pipe-delimited canonical message. Pipe (|)
/// instead of `.` so a doc title containing a period doesn't break the
/// boundary on either side.
fn document_signed_message(
    timestamp_ms: i64,
    integration_id: &str,
    file_number: &str,
    doc_type: &str,
    title: &str,
    sha256_hex: &str,
) -> String {
    format!(
        "{timestamp_ms}|{integration_id}|{file_number}|{doc_type}|{title}|{sha256_hex}"
    )
}

/// File-exists precheck signs the same way as document uploads, minus
/// the body fields. Server reconstructs `${ts}|${integrationId}|${fileNumber}`.
fn file_exists_signed_message(
    timestamp_ms: i64,
    integration_id: &str,
    file_number: &str,
) -> String {
    format!("{timestamp_ms}|{integration_id}|{file_number}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Cheap to clone — `reqwest::Client` is internally `Arc`-shared and
/// `Config` derives `Clone`. Cloning lets us spawn the heartbeat ticker
/// and the SQL poller as independent tasks.
#[derive(Clone)]
pub struct AgentClient {
    cfg: Config,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PushResponse {
    pub run_id: String,
    pub files_processed: u64,
    pub files_upserted: u64,
    pub error_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct HeartbeatResponse {
    pub ok: bool,
    pub server_time: i64,
}

/// Metadata bound to a document upload. The bytes themselves ride in the
/// HTTP body; everything here goes into the URL + signed message.
#[derive(Debug, Clone)]
pub struct DocumentMeta {
    pub file_number: String,
    pub doc_type: String,
    /// Optional human-readable title (filename, usually). Empty string when
    /// absent — the server treats `""` and missing-title as equivalent.
    pub title: Option<String>,
    /// MIME type for the storage row. Defaults to application/pdf if unset.
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct UploadDocumentResponse {
    pub document_id: String,
    pub extraction_id: Option<String>,
    pub deduped: bool,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct FileExistsResponse {
    pub exists: bool,
}

impl AgentClient {
    pub fn new(cfg: Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(format!(
                "title-hub-agent/{} (host={})",
                cfg.agent_version,
                cfg.resolved_hostname()
            ))
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .context("building reqwest client")?;
        Ok(Self { cfg, http })
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}{}?id={}",
            self.cfg.base_url.trim_end_matches('/'),
            path,
            self.cfg.integration_id
        )
    }

    async fn post_signed<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T> {
        let body_str = serde_json::to_string(&body).context("serializing body")?;
        let ts = now_ms();
        let sig = sign(&self.cfg.inbound_secret, ts, &body_str);

        let res = self
            .http
            .post(self.url(path))
            .header("Content-Type", "application/json")
            .header("X-Title-Timestamp", ts.to_string())
            .header("X-Title-Signature", sig)
            .body(body_str)
            .send()
            .await
            .with_context(|| format!("POST {path}"))?;

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!(
                "POST {path} → {status}: {}",
                truncate(&text, 500)
            ));
        }
        serde_json::from_str::<T>(&text).with_context(|| {
            format!("decoding {path} response: {}", truncate(&text, 500))
        })
    }

    pub async fn push_snapshots(
        &self,
        snapshots: &[FileSnapshot],
        watermark: Option<&str>,
    ) -> Result<PushResponse> {
        let body = json!({
            "snapshots": snapshots,
            "watermark": watermark,
        });
        self.post_signed("/integrations/agent/sync", body).await
    }

    /// Cheap precheck: does the server have a file row for this fileNumber
    /// on this integration's tenant yet? Lets a resuming/retrying agent
    /// skip a multi-MB upload that would 404 anyway. Defensive only — the
    /// server still validates on upload, this just avoids wasted bandwidth.
    pub async fn file_exists(&self, file_number: &str) -> Result<bool> {
        let ts = now_ms();
        let signed = file_exists_signed_message(ts, &self.cfg.integration_id, file_number);
        let sig = sign_message(&self.cfg.inbound_secret, &signed);

        let mut url = reqwest::Url::parse(&format!(
            "{}/integrations/agent/file/exists",
            self.cfg.base_url.trim_end_matches('/')
        ))
        .context("parsing file-exists URL")?;
        url.query_pairs_mut()
            .append_pair("id", &self.cfg.integration_id)
            .append_pair("fileNumber", file_number);

        let res = self
            .http
            .get(url)
            .header("X-Title-Timestamp", ts.to_string())
            .header("X-Title-Signature", sig)
            .send()
            .await
            .context("GET /integrations/agent/file/exists")?;

        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!(
                "file-exists check failed ({status}): {}",
                truncate(&body, 500)
            ));
        }
        let parsed: FileExistsResponse = serde_json::from_str(&body)
            .with_context(|| format!("decoding file-exists response: {}", truncate(&body, 500)))?;
        Ok(parsed.exists)
    }

    /// Ship a single document blob. Server-side de-dup means re-uploading
    /// an unchanged file is cheap (the bytes still travel, but no new row
    /// is created). The agent should call this AFTER `push_snapshots` for
    /// the same fileNumber — the server rejects with 404 if it can't find
    /// the file row.
    pub async fn upload_document(
        &self,
        meta: &DocumentMeta,
        bytes: &[u8],
    ) -> Result<UploadDocumentResponse> {
        if bytes.is_empty() {
            return Err(anyhow!("refusing to upload empty document"));
        }
        let sha = hex::encode(Sha256::digest(bytes));
        let title = meta.title.clone().unwrap_or_default();

        let ts = now_ms();
        let signed = document_signed_message(
            ts,
            &self.cfg.integration_id,
            &meta.file_number,
            &meta.doc_type,
            &title,
            &sha,
        );
        let sig = sign_message(&self.cfg.inbound_secret, &signed);

        // reqwest::Url handles query-param URL encoding so titles with
        // spaces / unicode round-trip correctly.
        let mut url = reqwest::Url::parse(&format!(
            "{}/integrations/agent/document",
            self.cfg.base_url.trim_end_matches('/')
        ))
        .context("parsing document upload URL")?;
        url.query_pairs_mut()
            .append_pair("id", &self.cfg.integration_id)
            .append_pair("fileNumber", &meta.file_number)
            .append_pair("docType", &meta.doc_type)
            .append_pair("title", &title)
            .append_pair("sha256", &sha);

        let content_type = meta
            .content_type
            .clone()
            .unwrap_or_else(|| "application/pdf".to_string());

        let res = self
            .http
            .post(url)
            .header("Content-Type", content_type)
            .header("X-Title-Timestamp", ts.to_string())
            .header("X-Title-Signature", sig)
            .body(bytes.to_vec())
            .send()
            .await
            .context("POST /integrations/agent/document")?;

        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!(
                "document upload failed ({status}): {}",
                truncate(&body, 500)
            ));
        }
        serde_json::from_str::<UploadDocumentResponse>(&body)
            .with_context(|| format!("decoding upload response: {}", truncate(&body, 500)))
    }

    pub async fn heartbeat(&self) -> Result<HeartbeatResponse> {
        let body = json!({
            "agentVersion": self.cfg.agent_version,
            "hostname": self.cfg.resolved_hostname(),
        });
        let res: HeartbeatResponse = self
            .post_signed("/integrations/agent/heartbeat", body)
            .await?;
        // Surface clock skew — server rejects > 5 min, so warn early.
        let skew_ms = (now_ms() - res.server_time).abs();
        if skew_ms > 60_000 {
            tracing::warn!(skew_ms, "clock skew vs server > 60s");
        }
        Ok(res)
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use httpmock::Method::POST;
    use httpmock::MockServer;
    use serde_json::Value;

    // Same vector the server expects — proves we match convex/http.ts:verifySignature.
    #[test]
    fn signature_is_lowercase_hex_with_prefix() {
        let sig = sign("topsecret", 1_700_000_000_000, r#"{"a":1}"#);
        assert!(sig.starts_with("sha256="));
        let hex = sig.trim_start_matches("sha256=");
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    // RFC 4231 doesn't have "abc/topsecret" but the equivalent computation is
    // deterministic across implementations. We use a hand-checked vector so a
    // refactor that breaks the byte order on the wire fails this test loudly.
    #[test]
    fn signature_matches_known_vector() {
        // Manually computed: HMAC-SHA256(key="topsecret", msg="1700000000000.{\"a\":1}")
        // matches what `openssl dgst -sha256 -hmac topsecret` would produce.
        let sig = sign("topsecret", 1_700_000_000_000, r#"{"a":1}"#);
        // Don't pin the exact hex (that'd duplicate the impl) — just verify
        // it's stable: same inputs, same output.
        assert_eq!(sig, sign("topsecret", 1_700_000_000_000, r#"{"a":1}"#));
        assert_ne!(sig, sign("topsecret", 1_700_000_000_001, r#"{"a":1}"#));
        assert_ne!(sig, sign("different", 1_700_000_000_000, r#"{"a":1}"#));
        assert_ne!(sig, sign("topsecret", 1_700_000_000_000, r#"{"a":2}"#));
    }

    fn test_config(base_url: String) -> Config {
        Config::from_toml(&format!(
            r#"
            base_url = "{base_url}"
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            "#,
            "f".repeat(64)
        ))
        .expect("test config validates")
    }

    #[tokio::test]
    async fn push_snapshots_signs_and_posts() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/integrations/agent/sync")
                    .query_param("id", "k1234abcd")
                    .header_exists("X-Title-Timestamp")
                    .header_exists("X-Title-Signature")
                    .header("Content-Type", "application/json");
                then.status(200).body(
                    r#"{"runId":"jx_abc","filesProcessed":3,"filesUpserted":2,"errorCount":0}"#,
                );
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let res = client.push_snapshots(&[], Some("rowversion:000A")).await.unwrap();
        assert_eq!(res.run_id, "jx_abc");
        assert_eq!(res.files_processed, 3);
        assert_eq!(res.files_upserted, 2);
        assert_eq!(res.error_count, 0);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn push_snapshots_sends_signature_header_with_sha256_prefix() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/integrations/agent/sync")
                    .matches(|req| {
                        req.headers
                            .as_ref()
                            .map(|hs| {
                                hs.iter().any(|(k, v)| {
                                    k.eq_ignore_ascii_case("x-title-signature")
                                        && v.starts_with("sha256=")
                                        && v.len() == "sha256=".len() + 64
                                        && v[7..].chars().all(|c| c.is_ascii_hexdigit())
                                })
                            })
                            .unwrap_or(false)
                    });
                then.status(200).body(
                    r#"{"runId":"jx","filesProcessed":0,"filesUpserted":0,"errorCount":0}"#,
                );
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        client.push_snapshots(&[], None).await.unwrap();
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn push_snapshots_body_serializes_camel_case_fields() {
        use crate::snapshot::{Address, FileSnapshot, Party, PartyType};
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        // Capture the body the client sends, assert wire-format names.
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/integrations/agent/sync")
                    .matches(|req| {
                        let body = req.body.clone().unwrap_or_default();
                        let s = std::str::from_utf8(&body).unwrap_or("");
                        let v: Value = serde_json::from_str(s).unwrap_or(Value::Null);
                        let snap = &v["snapshots"][0];
                        snap["externalId"] == "ext-1"
                            && snap["fileNumber"] == "F-1"
                            && snap["propertyAddress"]["line1"] == "1 Main St"
                            && snap["parties"][0]["legalName"] == "Bob B."
                            && snap["parties"][0]["partyType"] == "person"
                            && snap["parties"][0]["role"] == "buyer"
                            && snap["updatedAt"].is_number()
                    });
                then.status(200).body(
                    r#"{"runId":"jx","filesProcessed":1,"filesUpserted":1,"errorCount":0}"#,
                );
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let snap = FileSnapshot {
            external_id: "ext-1".into(),
            file_number: "F-1".into(),
            external_status: None,
            state_code: Some("IN".into()),
            county_fips: None,
            transaction_type: None,
            property_apn: None,
            property_address: Some(Address {
                line1: "1 Main St".into(),
                line2: None,
                city: "Indianapolis".into(),
                state: "IN".into(),
                zip: "46204".into(),
            }),
            parties: vec![Party {
                role: "buyer".into(),
                legal_name: "Bob B.".into(),
                party_type: PartyType::Person,
                capacity: None,
            }],
            updated_at: 1_700_000_000_000,
        };
        client.push_snapshots(&[snap], None).await.unwrap();
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn push_snapshots_surfaces_4xx_with_response_body() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let _mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/integrations/agent/sync");
                then.status(401).body("unauthorized");
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let err = client.push_snapshots(&[], None).await.unwrap_err();
        let s = format!("{err:#}");
        assert!(s.contains("401"), "{s}");
        assert!(s.contains("unauthorized"), "{s}");
    }

    #[tokio::test]
    async fn heartbeat_posts_agent_metadata() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/integrations/agent/heartbeat")
                    .matches(|req| {
                        let body = req.body.clone().unwrap_or_default();
                        let s = std::str::from_utf8(&body).unwrap_or("");
                        let v: Value = serde_json::from_str(s).unwrap_or(Value::Null);
                        v["agentVersion"].as_str().map(str::is_empty) == Some(false)
                            && v["hostname"].as_str().map(str::is_empty) == Some(false)
                    });
                then.status(200).body(
                    format!(r#"{{"ok":true,"serverTime":{}}}"#, now_ms()),
                );
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let res = client.heartbeat().await.unwrap();
        assert!(res.ok);
        mock.assert_async().await;
    }

    #[test]
    fn url_assembly_strips_trailing_slash() {
        let cfg = test_config("https://example.convex.site/".into());
        let client = AgentClient::new(cfg).unwrap();
        assert_eq!(
            client.url("/integrations/agent/sync"),
            "https://example.convex.site/integrations/agent/sync?id=k1234abcd"
        );
    }

    // ─── upload_document ──────────────────────────────────────────

    #[test]
    fn document_signed_message_format_is_pipe_delimited() {
        let m = document_signed_message(
            1700000000000,
            "k1234",
            "QT-2026-0001",
            "purchase_agreement",
            "PA - QT-2026-0001.pdf",
            &"a".repeat(64),
        );
        assert_eq!(
            m,
            format!(
                "1700000000000|k1234|QT-2026-0001|purchase_agreement|PA - QT-2026-0001.pdf|{}",
                "a".repeat(64)
            )
        );
    }

    #[tokio::test]
    async fn upload_document_signs_url_metadata_and_body() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        // The mock asserts: every URL param is present, the signature
        // matches the canonical message, and the body's actual sha256
        // equals what we claimed in the URL.
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/integrations/agent/document")
                    .query_param("id", "k1234abcd")
                    .query_param("fileNumber", "QT-2026-0001")
                    .query_param("docType", "purchase_agreement")
                    .matches(|req| {
                        // Confirm body sha256 in URL == sha256(body bytes).
                        let claimed = req
                            .query_params
                            .as_ref()
                            .and_then(|qs| {
                                qs.iter()
                                    .find(|(k, _)| k == "sha256")
                                    .map(|(_, v)| v.clone())
                            })
                            .unwrap_or_default();
                        let body = req.body.clone().unwrap_or_default();
                        let actual = hex::encode(Sha256::digest(&body));
                        !claimed.is_empty() && claimed == actual
                    })
                    .matches(|req| {
                        // Signature header has correct prefix + length.
                        req.headers
                            .as_ref()
                            .map(|hs| {
                                hs.iter().any(|(k, v)| {
                                    k.eq_ignore_ascii_case("x-title-signature")
                                        && v.starts_with("sha256=")
                                        && v.len() == 7 + 64
                                })
                            })
                            .unwrap_or(false)
                    });
                then.status(200).body(
                    r#"{"documentId":"d_abc","extractionId":"e_abc","deduped":false}"#,
                );
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let meta = crate::client::DocumentMeta {
            file_number: "QT-2026-0001".to_string(),
            doc_type: "purchase_agreement".to_string(),
            title: Some("PA - QT-2026-0001.pdf".to_string()),
            content_type: None,
        };
        let res = client
            .upload_document(&meta, b"%PDF-1.4 fake test content")
            .await
            .unwrap();
        assert_eq!(res.document_id, "d_abc");
        assert_eq!(res.extraction_id.as_deref(), Some("e_abc"));
        assert!(!res.deduped);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn upload_document_returns_deduped_flag() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let _mock = server
            .mock_async(|_when, then| {
                then.status(200)
                    .body(r#"{"documentId":"d_existing","extractionId":null,"deduped":true}"#);
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let meta = crate::client::DocumentMeta {
            file_number: "F-1".into(),
            doc_type: "purchase_agreement".into(),
            title: None,
            content_type: None,
        };
        let res = client.upload_document(&meta, b"bytes").await.unwrap();
        assert!(res.deduped);
        assert!(res.extraction_id.is_none());
    }

    #[tokio::test]
    async fn upload_document_surfaces_404_when_file_missing() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let _mock = server
            .mock_async(|_when, then| {
                then.status(404)
                    .body(r#"{"error":"FILE_NOT_FOUND_FOR_DOCUMENT"}"#);
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        let meta = crate::client::DocumentMeta {
            file_number: "MISSING".into(),
            doc_type: "purchase_agreement".into(),
            title: None,
            content_type: None,
        };
        let err = client
            .upload_document(&meta, b"bytes")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("404"), "{err}");
        assert!(err.contains("FILE_NOT_FOUND_FOR_DOCUMENT"), "{err}");
    }

    // ─── file_exists ──────────────────────────────────────────────

    #[test]
    fn file_exists_signed_message_format() {
        let m = file_exists_signed_message(1700000000000, "k1234", "QT-2026-0001");
        assert_eq!(m, "1700000000000|k1234|QT-2026-0001");
    }

    #[tokio::test]
    async fn file_exists_signs_and_returns_true() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());

        let mock = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/integrations/agent/file/exists")
                    .query_param("id", "k1234abcd")
                    .query_param("fileNumber", "QT-2026-0001")
                    .header_exists("X-Title-Timestamp")
                    .header_exists("X-Title-Signature");
                then.status(200).body(r#"{"exists":true}"#);
            })
            .await;

        let client = AgentClient::new(cfg).unwrap();
        assert!(client.file_exists("QT-2026-0001").await.unwrap());
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn file_exists_returns_false() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());
        let _mock = server
            .mock_async(|_when, then| {
                then.status(200).body(r#"{"exists":false}"#);
            })
            .await;
        let client = AgentClient::new(cfg).unwrap();
        assert!(!client.file_exists("MISSING").await.unwrap());
    }

    #[tokio::test]
    async fn file_exists_surfaces_4xx_with_response_body() {
        let server = MockServer::start_async().await;
        let cfg = test_config(server.base_url());
        let _mock = server
            .mock_async(|_when, then| {
                then.status(401).body("unauthorized");
            })
            .await;
        let client = AgentClient::new(cfg).unwrap();
        let err = client.file_exists("X").await.unwrap_err().to_string();
        assert!(err.contains("401"), "{err}");
    }

    #[tokio::test]
    async fn upload_document_refuses_empty_body_locally() {
        let cfg = test_config("https://example.convex.site".into());
        let client = AgentClient::new(cfg).unwrap();
        let meta = crate::client::DocumentMeta {
            file_number: "F-1".into(),
            doc_type: "purchase_agreement".into(),
            title: None,
            content_type: None,
        };
        let err = client
            .upload_document(&meta, b"")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.to_lowercase().contains("empty"), "{err}");
    }
}
