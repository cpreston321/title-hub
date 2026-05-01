// ProForm (SoftPro Standard) SQL Server poller.
//
// Status: scaffolded. Connection + watermark loop are real; the
// `query_changed_orders` field-mapping function is intentionally left as a
// stub returning an empty Vec — wire up real ProForm column names against a
// live test DB before pointing this at a customer install.
//
// Watermark strategy: SQL Server's `rowversion` column on the orders table
// is monotonic per database. The agent stores the highest rowversion it has
// successfully shipped on the integration row (as `agentWatermark` server-
// side, persisted via `client.push_snapshots(..., Some(&watermark))`). On
// startup the agent doesn't need local state — the next run after a crash
// re-fetches from the server's stored watermark via a small bootstrap query.
// (Bootstrap query lives in the server side; for the first version we just
// poll `WHERE rowversion > @local_watermark` and start from 0 if unknown.)

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use tiberius::{AuthMethod, Client, Config as TiberiusConfig, EncryptionLevel};
use tokio::net::TcpStream;
use tokio::time::sleep;
use tokio_util::compat::TokioAsyncWriteCompatExt;
use tracing::{debug, info, warn};

use crate::client::AgentClient;
use crate::config::ProformConfig;
use crate::snapshot::FileSnapshot;

pub struct ProformPoller {
    cfg: ProformConfig,
    /// Hex-encoded `rowversion` of the highest row already shipped. Empty
    /// string on first run. SQL Server represents rowversion as 8 bytes;
    /// hex is a stable round-trip for both the server's `agentWatermark`
    /// string column and the `WHERE rowversion > @wm` predicate.
    watermark: String,
}

impl ProformPoller {
    pub fn new(cfg: ProformConfig, initial_watermark: Option<String>) -> Self {
        Self {
            cfg,
            watermark: initial_watermark.unwrap_or_default(),
        }
    }

    fn build_tiberius_config(&self) -> Result<TiberiusConfig> {
        if let Some(s) = self.cfg.ado_connection_string.as_deref() {
            return TiberiusConfig::from_ado_string(s)
                .context("parsing ADO connection string");
        }

        let host = self
            .cfg
            .host
            .as_deref()
            .ok_or_else(|| anyhow!("proform.host or proform.ado_connection_string required"))?;
        let username = self
            .cfg
            .username
            .as_deref()
            .ok_or_else(|| anyhow!("proform.username required (Windows integrated auth not yet supported)"))?;
        let password = self
            .cfg
            .password
            .as_deref()
            .ok_or_else(|| anyhow!("proform.password required"))?;

        let mut tcfg = TiberiusConfig::new();
        tcfg.host(host);
        tcfg.port(self.cfg.port);
        tcfg.database(&self.cfg.database);
        tcfg.authentication(AuthMethod::sql_server(username, password));
        tcfg.encryption(if self.cfg.trust_cert {
            EncryptionLevel::Required
        } else {
            EncryptionLevel::Required
        });
        if self.cfg.trust_cert {
            tcfg.trust_cert();
        }
        Ok(tcfg)
    }

    async fn connect(&self) -> Result<Client<tokio_util::compat::Compat<TcpStream>>> {
        let tcfg = self.build_tiberius_config()?;
        let tcp = TcpStream::connect(tcfg.get_addr())
            .await
            .with_context(|| format!("TCP connect to {}", tcfg.get_addr()))?;
        tcp.set_nodelay(true).ok();
        let client = Client::connect(tcfg, tcp.compat_write())
            .await
            .context("SQL Server handshake")?;
        Ok(client)
    }

    /// One poll cycle: connect, read changed rows since the last watermark,
    /// push them in server-bounded batches, advance the watermark on success.
    pub async fn poll_once(&mut self, agent: &AgentClient) -> Result<u64> {
        let mut client = self.connect().await?;

        let (snapshots, new_watermark) =
            query_changed_orders(&mut client, &self.watermark, self.cfg.batch_size).await?;

        if snapshots.is_empty() {
            debug!(?self.watermark, "no changed orders");
            return Ok(0);
        }

        // Server caps each push at 100. Page through if a single poll
        // surfaces more (rare; batch_size already constrains this, but be
        // defensive against future config changes).
        const SERVER_CAP: usize = 100;
        let mut shipped = 0u64;
        for chunk in snapshots.chunks(SERVER_CAP) {
            let res = agent
                .push_snapshots(chunk, Some(&new_watermark))
                .await
                .context("push to server")?;
            shipped += res.files_processed;
        }

        self.watermark = new_watermark;
        info!(shipped, watermark = %self.watermark, "ProForm poll succeeded");
        Ok(shipped)
    }

    pub async fn run_forever(mut self, agent: &AgentClient) -> Result<()> {
        let interval = Duration::from_secs(self.cfg.poll_interval_secs.max(5));
        loop {
            match self.poll_once(agent).await {
                Ok(_) => {}
                Err(e) => warn!("ProForm poll failed: {e:#}"),
            }
            sleep(interval).await;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────
// Field mapping (TODO — pilot work)
//
// This is the part you can only finish against a real ProForm install.
// Replace the stub query with the actual schema and map columns onto
// FileSnapshot. Useful starting points (verify against the customer's
// schema version — SoftPro renames things between releases):
//
//   • Orders are typically in `dbo.OrderHeader` keyed by `OrderID`.
//   • Each order has a `Rowversion` (timestamp/binary) column.
//   • Buyer/seller names land in `dbo.OrderName` keyed by `OrderID`.
//   • Property address: `dbo.OrderProperty`.
//   • Transaction type: stored as a code on the order header.
//
// The query below is a placeholder; real implementation shape:
//
//   SELECT TOP (@batch)
//     CONVERT(varchar(20), OrderID) AS external_id,
//     OrderNumber                    AS file_number,
//     CONVERT(varchar(34), CONVERT(binary(8), Rowversion), 1) AS new_watermark,
//     ...
//   FROM dbo.OrderHeader
//   WHERE Rowversion > CONVERT(binary(8), CONVERT(varbinary(8), @wm, 1))
//   ORDER BY Rowversion ASC;
//
// then a follow-up SELECT for parties + property keyed by OrderID.
// ──────────────────────────────────────────────────────────────────────

async fn query_changed_orders(
    _client: &mut Client<tokio_util::compat::Compat<TcpStream>>,
    _watermark_hex: &str,
    _batch_size: u32,
) -> Result<(Vec<FileSnapshot>, String)> {
    // TODO(pilot): implement real ProForm SELECT + mapping.
    // For now: connect succeeds, no rows returned, watermark unchanged.
    warn!(
        "ProForm field mapping not implemented yet — wire up against the agency's ProForm schema"
    );
    Ok((Vec::new(), String::new()))
}
