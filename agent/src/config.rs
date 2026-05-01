use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Convex HTTP Actions URL, e.g. https://your-deployment.convex.site
    pub base_url: String,
    /// Convex Id of the integration row this agent is bound to.
    pub integration_id: String,
    /// 64-char hex HMAC secret. Sensitive — store with restrictive ACLs.
    pub inbound_secret: String,

    #[serde(default = "default_agent_version")]
    pub agent_version: String,
    /// Optional. Falls back to the OS hostname.
    #[serde(default)]
    pub hostname: Option<String>,

    /// Optional ProForm SQL Server polling config. When absent, `agent run`
    /// only sends heartbeats — useful for first-deploy verification.
    #[serde(default)]
    pub proform: Option<ProformConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProformConfig {
    /// Full ADO.NET-style connection string. If set, host/port/etc are ignored.
    #[serde(default)]
    pub ado_connection_string: Option<String>,

    #[serde(default)]
    pub host: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_database")]
    pub database: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// Skip cert validation. Most agency SQL Servers run self-signed certs.
    #[serde(default = "default_trust_cert")]
    pub trust_cert: bool,

    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_batch_size")]
    pub batch_size: u32,
}

fn default_port() -> u16 {
    1433
}
fn default_database() -> String {
    "ProForm".into()
}
fn default_trust_cert() -> bool {
    true
}
fn default_poll_interval() -> u64 {
    15
}
fn default_batch_size() -> u32 {
    50
}

fn default_agent_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config at {}", path.display()))?;
        Self::from_toml(&raw)
            .with_context(|| format!("loading config from {}", path.display()))
    }

    /// Parse + validate without touching the filesystem. Used by `agent init`
    /// to verify a pasted TOML block before writing it to disk, and by tests.
    pub fn from_toml(raw: &str) -> Result<Self> {
        let cfg: Config = toml::from_str(raw).context("parsing TOML")?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<()> {
        if self.base_url.trim().is_empty() {
            anyhow::bail!("base_url is empty — paste the .convex.site URL from the admin UI");
        }
        if self.integration_id.trim().is_empty() {
            anyhow::bail!(
                "integration_id is empty — copy it from the admin UI's \"Agent install\" panel"
            );
        }
        if self.inbound_secret.trim().is_empty() {
            anyhow::bail!(
                "inbound_secret is empty — copy it from the admin UI's \"Agent install\" panel"
            );
        }
        // Server requires .convex.site (HTTP Actions URL), not .convex.cloud.
        if self.base_url.ends_with(".convex.cloud") {
            anyhow::bail!(
                "base_url should be the .convex.site HTTP Actions URL, not .convex.cloud"
            );
        }
        if !self.base_url.starts_with("http://") && !self.base_url.starts_with("https://") {
            anyhow::bail!("base_url must include the scheme (https://...)");
        }
        // Inbound secret is a 64-char hex string from the server's
        // `newSecret()` in convex/integrations.ts. Length-check catches
        // copy-paste truncation early.
        if self.inbound_secret.len() != 64
            || !self.inbound_secret.chars().all(|c| c.is_ascii_hexdigit())
        {
            anyhow::bail!(
                "inbound_secret should be 64 hex characters; got {} chars",
                self.inbound_secret.len()
            );
        }
        Ok(())
    }

    pub fn resolved_hostname(&self) -> String {
        self.hostname
            .clone()
            .or_else(|| {
                hostname::get()
                    .ok()
                    .and_then(|h| h.into_string().ok())
            })
            .unwrap_or_else(|| "unknown".to_string())
    }
}

/// Where the agent looks for its config when `--config` isn't set
/// explicitly. Searched in order; the first one that exists wins. The
/// "preferred write location" used by `agent init` is the first entry.
pub fn default_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if cfg!(windows) {
        // %PROGRAMDATA%\TitleHubAgent\agent.toml — readable by the service
        // user, hidden from regular users by default ACL on ProgramData.
        if let Some(pd) = std::env::var_os("ProgramData") {
            paths.push(PathBuf::from(pd).join("TitleHubAgent").join("agent.toml"));
        }
    } else {
        if let Some(home) = dirs::config_dir() {
            paths.push(home.join("title-hub-agent").join("agent.toml"));
        }
        paths.push(PathBuf::from("/etc/title-hub-agent/agent.toml"));
    }

    paths.push(PathBuf::from("agent.toml"));
    paths
}

/// Resolve the config path: explicit `--config` wins; otherwise the first
/// existing default. If nothing exists, returns the *write target* (first
/// default path) so callers like `agent init` know where to put new files.
pub fn resolve_config_path(explicit: Option<&Path>) -> PathBuf {
    if let Some(p) = explicit {
        return p.to_path_buf();
    }
    let defaults = default_config_paths();
    for p in &defaults {
        if p.exists() {
            return p.clone();
        }
    }
    defaults
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("agent.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_config() -> String {
        format!(
            r#"
            base_url = "https://example.convex.site"
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            "#,
            "a".repeat(64)
        )
    }

    #[test]
    fn parses_a_complete_config() {
        let cfg = Config::from_toml(&ok_config()).unwrap();
        assert_eq!(cfg.base_url, "https://example.convex.site");
        assert_eq!(cfg.integration_id, "k1234abcd");
        assert_eq!(cfg.inbound_secret.len(), 64);
        assert_eq!(cfg.agent_version, env!("CARGO_PKG_VERSION"));
        assert!(cfg.proform.is_none());
    }

    #[test]
    fn rejects_empty_base_url() {
        let raw = format!(
            r#"
            base_url = ""
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            "#,
            "a".repeat(64)
        );
        let err = Config::from_toml(&raw).unwrap_err().to_string();
        assert!(err.contains("base_url is empty"), "{err}");
    }

    #[test]
    fn rejects_convex_cloud_url() {
        let raw = format!(
            r#"
            base_url = "https://example.convex.cloud"
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            "#,
            "a".repeat(64)
        );
        let err = Config::from_toml(&raw).unwrap_err().to_string();
        assert!(err.contains("convex.site"), "{err}");
    }

    #[test]
    fn rejects_url_without_scheme() {
        let raw = format!(
            r#"
            base_url = "example.convex.site"
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            "#,
            "a".repeat(64)
        );
        let err = Config::from_toml(&raw).unwrap_err().to_string();
        assert!(err.contains("scheme"), "{err}");
    }

    #[test]
    fn rejects_truncated_secret() {
        let raw = r#"
            base_url = "https://example.convex.site"
            integration_id = "k1234abcd"
            inbound_secret = "abc123"
        "#;
        let err = Config::from_toml(raw).unwrap_err().to_string();
        assert!(err.contains("64 hex characters"), "{err}");
    }

    #[test]
    fn rejects_non_hex_secret() {
        // 64 chars but not hex.
        let raw = format!(
            r#"
            base_url = "https://example.convex.site"
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            "#,
            "Z".repeat(64)
        );
        let err = Config::from_toml(&raw).unwrap_err().to_string();
        assert!(err.contains("hex characters"), "{err}");
    }

    #[test]
    fn parses_optional_proform_block() {
        let raw = format!(
            r#"
            base_url = "https://example.convex.site"
            integration_id = "k1234abcd"
            inbound_secret = "{}"

            [proform]
            host = "DBHOST"
            username = "agent_user"
            password = "secret"
            "#,
            "a".repeat(64)
        );
        let cfg = Config::from_toml(&raw).unwrap();
        let pf = cfg.proform.expect("proform block parses");
        assert_eq!(pf.host.as_deref(), Some("DBHOST"));
        assert_eq!(pf.port, 1433); // default
        assert_eq!(pf.database, "ProForm"); // default
        assert!(pf.trust_cert);
        assert_eq!(pf.poll_interval_secs, 15);
        assert_eq!(pf.batch_size, 50);
    }

    #[test]
    fn explicit_config_path_wins_over_defaults() {
        let p = PathBuf::from("/tmp/explicit.toml");
        assert_eq!(resolve_config_path(Some(&p)), p);
    }

    #[test]
    fn default_config_paths_includes_local_fallback() {
        let paths = default_config_paths();
        assert!(paths.iter().any(|p| p == Path::new("agent.toml")));
    }

    #[test]
    fn resolved_hostname_falls_back_when_unset() {
        let raw = ok_config();
        let cfg = Config::from_toml(&raw).unwrap();
        // Either the OS hostname or "unknown" — never panics.
        let h = cfg.resolved_hostname();
        assert!(!h.is_empty());
    }

    #[test]
    fn resolved_hostname_uses_explicit_value_if_set() {
        let raw = format!(
            r#"
            base_url = "https://example.convex.site"
            integration_id = "k1234abcd"
            inbound_secret = "{}"
            hostname = "DESKTOP-AGENCY-01"
            "#,
            "a".repeat(64)
        );
        let cfg = Config::from_toml(&raw).unwrap();
        assert_eq!(cfg.resolved_hostname(), "DESKTOP-AGENCY-01");
    }
}
