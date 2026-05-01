// `agent init` and `agent doctor` — friction-reducers for the agency IT
// admin who is installing this for the first time. `init` writes a TOML
// block (typically pasted from the admin UI) to the OS-appropriate config
// path. `doctor` runs the same preflight checks they'd otherwise hit by
// trial-and-error.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::client::AgentClient;
use crate::config::{Config, default_config_paths};

/// Read TOML from the given path or stdin (when `path` is None or "-"),
/// validate it, and write it to the chosen target with restrictive
/// permissions. Returns the path it wrote to.
pub fn run_init(
    source: Option<&Path>,
    target: Option<&Path>,
    overwrite: bool,
) -> Result<PathBuf> {
    let raw = read_source(source)?;
    // Validate before touching disk so a typo in the paste doesn't leave a
    // half-broken file on the customer's machine.
    let _cfg = Config::from_toml(&raw).context("the pasted TOML didn't validate")?;

    let target = target
        .map(|p| p.to_path_buf())
        .unwrap_or_else(default_write_target);
    if target.exists() && !overwrite {
        anyhow::bail!(
            "{} already exists. Re-run with --overwrite to replace it.",
            target.display()
        );
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    write_with_restrictive_perms(&target, &raw)
        .with_context(|| format!("writing config to {}", target.display()))?;
    Ok(target)
}

fn read_source(source: Option<&Path>) -> Result<String> {
    match source {
        None => read_stdin(),
        Some(p) if p.as_os_str() == "-" => read_stdin(),
        Some(p) => std::fs::read_to_string(p)
            .with_context(|| format!("reading {}", p.display())),
    }
}

fn read_stdin() -> Result<String> {
    eprintln!(
        "Paste the install-token TOML from the admin UI, then press Ctrl-D \
         (Ctrl-Z on Windows) to finish:"
    );
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("reading stdin")?;
    if buf.trim().is_empty() {
        anyhow::bail!("nothing was pasted on stdin");
    }
    Ok(buf)
}

fn default_write_target() -> PathBuf {
    default_config_paths()
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("agent.toml"))
}

// ─── Token-based bootstrap (`agent install --token ...`) ──────────────
//
// Trades a short-lived install token issued by the admin UI for the
// long-lived inbound secret, then writes a complete agent.toml in one
// step. No copy-paste of TOML, no manual editing — the admin pastes a
// single command into the agency's terminal and is done.

#[derive(Debug, Serialize)]
struct RedeemRequest<'a> {
    token: &'a str,
}

#[derive(Debug, Deserialize)]
struct RedeemResponse {
    #[serde(rename = "integrationId")]
    integration_id: String,
    #[serde(rename = "inboundSecret")]
    inbound_secret: String,
}

pub async fn run_install(
    server: &str,
    token: &str,
    target: Option<&Path>,
    overwrite: bool,
) -> Result<PathBuf> {
    let server = server.trim_end_matches('/');
    if !server.starts_with("http://") && !server.starts_with("https://") {
        anyhow::bail!("--server must include the scheme (https://...)");
    }
    if server.ends_with(".convex.cloud") {
        anyhow::bail!(
            "--server should be the .convex.site HTTP Actions URL, not .convex.cloud"
        );
    }
    if !token.chars().all(|c| c.is_ascii_hexdigit()) || token.len() != 64 {
        anyhow::bail!("--token must be 64 hex characters");
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .context("building http client")?;

    let url = format!("{server}/integrations/agent/redeem");
    let res = http
        .post(&url)
        .json(&RedeemRequest { token })
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // The server maps domain errors onto 400/401, with a JSON body
        // like {"error":"INSTALL_TOKEN_EXPIRED"}. Translate to actionable
        // hints so the IT admin doesn't have to look up our enum.
        return Err(annotate_redeem_error(status.as_u16(), &body));
    }
    let payload: RedeemResponse = serde_json::from_str(&body)
        .with_context(|| format!("decoding redeem response: {body}"))?;

    let toml = render_install_toml(server, &payload.integration_id, &payload.inbound_secret);

    // Round-trip through Config::from_toml so a server-side bug that
    // produces an invalid bundle fails before we touch disk.
    Config::from_toml(&toml).context("server returned an invalid install bundle")?;

    let target = target
        .map(|p| p.to_path_buf())
        .unwrap_or_else(default_write_target);
    if target.exists() && !overwrite {
        anyhow::bail!(
            "{} already exists. Re-run with --overwrite to replace it.",
            target.display()
        );
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    write_with_restrictive_perms(&target, &toml)
        .with_context(|| format!("writing config to {}", target.display()))?;
    Ok(target)
}

fn render_install_toml(server: &str, integration_id: &str, inbound_secret: &str) -> String {
    format!(
        "# title-hub-agent — generated by `agent install`\n\
         base_url = \"{server}\"\n\
         integration_id = \"{integration_id}\"\n\
         inbound_secret = \"{inbound_secret}\"\n\
         agent_version = \"{}\"\n",
        env!("CARGO_PKG_VERSION")
    )
}

fn annotate_redeem_error(status: u16, body: &str) -> anyhow::Error {
    let kind = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(String::from))
        .unwrap_or_default();

    let hint = match kind.as_str() {
        "INSTALL_TOKEN_EXPIRED" => {
            "  → The install token has expired (15-min TTL). Generate a new \
             one in the admin UI and rerun this command."
        }
        "INSTALL_TOKEN_ALREADY_USED" => {
            "  → This token has already been redeemed. Tokens are single-use \
             — generate a fresh one if you need to reinstall."
        }
        "INSTALL_TOKEN_NOT_FOUND" => {
            "  → The server doesn't recognize this token. Re-copy it from \
             the admin UI (no spaces or line breaks in the paste)."
        }
        "INSTALL_TOKEN_MALFORMED" => "  → The token isn't a 64-char hex string.",
        "INTEGRATION_DISABLED" => {
            "  → The integration is disabled in the admin UI. Enable it \
             before installing the agent."
        }
        _ => "",
    };

    let label = if kind.is_empty() {
        format!("redeem failed ({status}): {body}")
    } else {
        format!("redeem failed ({status} {kind})")
    };
    if hint.is_empty() {
        anyhow!("{label}")
    } else {
        anyhow!("{label}\n{hint}")
    }
}

#[cfg(unix)]
fn write_with_restrictive_perms(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_with_restrictive_perms(path: &Path, contents: &str) -> std::io::Result<()> {
    // Windows ACL hardening would require the windows crate; the
    // ProgramData default path inherits a sensible ACL anyway. For now,
    // leave it at the default. `agent doctor` flags world-readability if
    // we ever extend the check.
    std::fs::write(path, contents)
}

#[derive(Debug)]
pub struct DoctorReport {
    pub config_path: PathBuf,
    pub config_ok: Result<()>,
    pub heartbeat: Result<i64>,
    pub clock_skew_ms: Option<i64>,
}

impl DoctorReport {
    pub fn is_healthy(&self) -> bool {
        self.config_ok.is_ok()
            && self.heartbeat.is_ok()
            && self.clock_skew_ms.map(|s| s.abs() < 60_000).unwrap_or(true)
    }

    pub fn print(&self) {
        println!("Title Hub agent — doctor");
        println!("════════════════════════");
        println!("config:    {}", self.config_path.display());
        match &self.config_ok {
            Ok(_) => println!("  ✓ config parses + validates"),
            Err(e) => println!("  ✗ {e:#}"),
        }
        match &self.heartbeat {
            Ok(server_time) => {
                println!("  ✓ heartbeat reached server (server_time={server_time})")
            }
            Err(e) => println!("  ✗ heartbeat failed: {e:#}"),
        }
        match self.clock_skew_ms {
            Some(s) if s.abs() >= 60_000 => println!(
                "  ⚠ clock skew vs server: {}ms (server rejects > 5min)",
                s
            ),
            Some(s) => println!("  ✓ clock skew vs server: {}ms", s),
            None => {}
        }
        if self.is_healthy() {
            println!("\nAll checks passed. The agent is ready to run with `agent run`.");
        } else {
            println!("\nFix the issues above, then re-run `agent doctor`.");
        }
    }
}

pub async fn run_doctor(config_path: &Path) -> Result<DoctorReport> {
    let mut report = DoctorReport {
        config_path: config_path.to_path_buf(),
        config_ok: Ok(()),
        heartbeat: Err(anyhow!("not attempted")),
        clock_skew_ms: None,
    };

    let cfg = match Config::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            report.config_ok = Err(e);
            return Ok(report);
        }
    };

    let client = match AgentClient::new(cfg) {
        Ok(c) => c,
        Err(e) => {
            report.config_ok = Err(e);
            return Ok(report);
        }
    };

    match client.heartbeat().await {
        Ok(res) => {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            report.clock_skew_ms = Some(now - res.server_time);
            report.heartbeat = Ok(res.server_time);
        }
        Err(e) => {
            // Wrap the raw error in actionable hints so the customer's IT
            // admin doesn't have to grep our source code.
            report.heartbeat = Err(annotate_heartbeat_error(e));
        }
    }

    Ok(report)
}

fn annotate_heartbeat_error(e: anyhow::Error) -> anyhow::Error {
    let msg = format!("{e:#}");
    let hint = if msg.contains("401") {
        "  → 401 from server. The inbound_secret in agent.toml probably doesn't \
         match the integration in the admin UI. Re-copy from \"Agent install\"."
    } else if msg.contains("404") {
        "  → 404 from server. The integration_id in agent.toml doesn't match a \
         row on the server. Re-copy from \"Agent install\"."
    } else if msg.to_lowercase().contains("dns") || msg.to_lowercase().contains("resolve") {
        "  → DNS lookup failed. Check base_url in agent.toml — it should be \
         the .convex.site URL from the admin UI."
    } else if msg.to_lowercase().contains("connect") || msg.to_lowercase().contains("connection") {
        "  → Couldn't reach the server. The agency's network may block \
         outbound HTTPS to .convex.site. Confirm with the IT team."
    } else if msg.contains("stale timestamp") {
        "  → Server rejected the timestamp. The agent's clock is more than 5 \
         minutes off from the server. Sync the system clock and retry."
    } else {
        ""
    };

    if hint.is_empty() {
        e
    } else {
        anyhow!("{msg}\n{hint}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ok_toml() -> String {
        format!(
            r#"
            base_url = "https://example.convex.site"
            integration_id = "k1234"
            inbound_secret = "{}"
            "#,
            "f".repeat(64)
        )
    }

    #[test]
    fn run_init_writes_validated_toml() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("paste.toml");
        let dst = dir.path().join("nested").join("agent.toml");
        std::fs::write(&src, ok_toml()).unwrap();

        let out = run_init(Some(&src), Some(&dst), false).unwrap();
        assert_eq!(out, dst);
        let written = std::fs::read_to_string(&dst).unwrap();
        assert!(written.contains("https://example.convex.site"));
    }

    #[test]
    fn run_init_rejects_invalid_paste_before_writing() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("paste.toml");
        let dst = dir.path().join("agent.toml");
        std::fs::write(&src, r#"base_url = "nope""#).unwrap();

        let err = run_init(Some(&src), Some(&dst), false).unwrap_err();
        assert!(err.to_string().contains("validate"));
        assert!(!dst.exists(), "must not write a half-validated file");
    }

    #[test]
    fn run_init_refuses_overwrite_unless_flagged() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("paste.toml");
        let dst = dir.path().join("agent.toml");
        std::fs::write(&src, ok_toml()).unwrap();
        std::fs::write(&dst, "previous").unwrap();

        let err = run_init(Some(&src), Some(&dst), false).unwrap_err();
        assert!(err.to_string().contains("--overwrite"), "{err}");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "previous");

        // With --overwrite it succeeds.
        run_init(Some(&src), Some(&dst), true).unwrap();
        let after = std::fs::read_to_string(&dst).unwrap();
        assert!(after.contains("https://example.convex.site"));
    }

    #[cfg(unix)]
    #[test]
    fn run_init_writes_owner_only_perms_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("paste.toml");
        let dst = dir.path().join("agent.toml");
        std::fs::write(&src, ok_toml()).unwrap();

        run_init(Some(&src), Some(&dst), false).unwrap();
        let mode = std::fs::metadata(&dst).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "config containing the secret must be 0600");
    }

    #[tokio::test]
    async fn doctor_reports_invalid_config() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("agent.toml");
        std::fs::write(&p, "base_url = \"\"").unwrap();
        let report = run_doctor(&p).await.unwrap();
        assert!(report.config_ok.is_err());
        assert!(!report.is_healthy());
    }

    #[tokio::test]
    async fn doctor_reports_unreachable_server_with_hint() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("agent.toml");
        // Point base_url at a port we know nothing's listening on.
        std::fs::write(
            &p,
            format!(
                r#"
                base_url = "http://127.0.0.1:1"
                integration_id = "k1"
                inbound_secret = "{}"
                "#,
                "f".repeat(64)
            ),
        )
        .unwrap();
        let report = run_doctor(&p).await.unwrap();
        assert!(report.config_ok.is_ok());
        assert!(report.heartbeat.is_err());
        assert!(!report.is_healthy());
    }

    #[test]
    fn annotate_adds_actionable_hint_for_401() {
        let raw = anyhow!("POST /integrations/agent/heartbeat → 401 Unauthorized: ...");
        let annotated = annotate_heartbeat_error(raw).to_string();
        assert!(annotated.contains("inbound_secret"), "{annotated}");
    }

    #[test]
    fn annotate_passes_through_unknown_errors() {
        let raw = anyhow!("some weird error");
        let annotated = annotate_heartbeat_error(raw).to_string();
        assert_eq!(annotated, "some weird error");
    }

    // ─── run_install ──────────────────────────────────────────────

    #[test]
    fn render_install_toml_passes_through_config_validation() {
        let toml = render_install_toml(
            "https://example.convex.site",
            "k1234abcd",
            &"f".repeat(64),
        );
        Config::from_toml(&toml).expect("rendered TOML must validate");
    }

    #[tokio::test]
    async fn run_install_redeems_and_writes_validated_toml() {
        use httpmock::{Method::POST, MockServer};

        let server = MockServer::start_async().await;
        let token = "a".repeat(64);
        let secret = "f".repeat(64);

        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/integrations/agent/redeem")
                    .json_body_obj(&serde_json::json!({ "token": "a".repeat(64) }));
                then.status(200).body(format!(
                    r#"{{"integrationId":"k_xyz","inboundSecret":"{}"}}"#,
                    "f".repeat(64)
                ));
            })
            .await;

        let dir = tempfile::TempDir::new().unwrap();
        let dst = dir.path().join("nested").join("agent.toml");
        let written =
            run_install(&server.base_url(), &token, Some(&dst), false).await.unwrap();
        assert_eq!(written, dst);
        let raw = std::fs::read_to_string(&dst).unwrap();
        assert!(raw.contains(&format!("base_url = \"{}\"", server.base_url())));
        assert!(raw.contains("integration_id = \"k_xyz\""));
        assert!(raw.contains(&format!("inbound_secret = \"{secret}\"")));
        // And the result must be loadable as a real Config.
        Config::from_toml(&raw).unwrap();
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn run_install_surfaces_expired_token_with_hint() {
        use httpmock::{Method::POST, MockServer};

        let server = MockServer::start_async().await;
        let _mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/integrations/agent/redeem");
                then.status(401)
                    .body(r#"{"error":"INSTALL_TOKEN_EXPIRED"}"#);
            })
            .await;

        let dir = tempfile::TempDir::new().unwrap();
        let dst = dir.path().join("agent.toml");
        let err = run_install(&server.base_url(), &"a".repeat(64), Some(&dst), false)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("INSTALL_TOKEN_EXPIRED"), "{err}");
        assert!(err.contains("Generate a new"), "expected actionable hint: {err}");
        assert!(!dst.exists(), "no file should be written on failure");
    }

    #[tokio::test]
    async fn run_install_rejects_malformed_token_locally() {
        let dir = tempfile::TempDir::new().unwrap();
        let dst = dir.path().join("agent.toml");
        let err = run_install("https://example.convex.site", "not-hex", Some(&dst), false)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("64 hex"), "{err}");
    }

    #[tokio::test]
    async fn run_install_rejects_convex_cloud_url() {
        let dir = tempfile::TempDir::new().unwrap();
        let dst = dir.path().join("agent.toml");
        let err = run_install(
            "https://example.convex.cloud",
            &"a".repeat(64),
            Some(&dst),
            false,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("convex.site"), "{err}");
    }

    #[tokio::test]
    async fn run_install_refuses_overwrite_unless_flagged() {
        use httpmock::{Method::POST, MockServer};

        let server = MockServer::start_async().await;
        let _mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/integrations/agent/redeem");
                then.status(200).body(format!(
                    r#"{{"integrationId":"k_xyz","inboundSecret":"{}"}}"#,
                    "f".repeat(64)
                ));
            })
            .await;

        let dir = tempfile::TempDir::new().unwrap();
        let dst = dir.path().join("agent.toml");
        std::fs::write(&dst, "previous").unwrap();

        let err = run_install(&server.base_url(), &"a".repeat(64), Some(&dst), false)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("--overwrite"), "{err}");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "previous");
    }
}
