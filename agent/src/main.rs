mod client;
mod config;
mod proform;
mod setup;
mod snapshot;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tokio::signal;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::client::AgentClient;
use crate::config::{Config, resolve_config_path};
use crate::proform::ProformPoller;
use crate::setup::{run_doctor, run_init, run_install};
use crate::snapshot::FileSnapshot;

#[derive(Parser, Debug)]
#[command(
    name = "title-hub-agent",
    about = "Customer-side agent for SoftPro Standard direct integrations",
    version
)]
struct Cli {
    /// Path to the TOML config. Defaults to the OS-appropriate location:
    ///   • Windows: %ProgramData%\TitleHubAgent\agent.toml
    ///   • macOS:   ~/Library/Application Support/title-hub-agent/agent.toml
    ///   • Linux:   ~/.config/title-hub-agent/agent.toml or /etc/title-hub-agent/agent.toml
    /// Falls back to ./agent.toml if none of those exist.
    #[arg(short, long, env = "AGENT_CONFIG")]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// One-line install: redeem a short-lived install token from the admin
    /// UI, fetch the inbound secret, write a complete config. This is the
    /// recommended path — no copy-pasting of long-lived secrets.
    Install {
        /// 64-char hex install token, generated in the admin UI.
        #[arg(long)]
        token: String,
        /// The deployment's HTTP Actions URL, e.g.
        /// https://your-deployment.convex.site
        #[arg(long)]
        server: String,
        /// Override the write target.
        #[arg(long)]
        to: Option<PathBuf>,
        /// Replace an existing config file.
        #[arg(long)]
        overwrite: bool,
    },
    /// Manual setup: paste the install-token TOML from the admin UI on
    /// stdin (or `--from-file path.toml`), agent validates and writes it to
    /// the OS-appropriate config location. Prefer `install` over `init` —
    /// `init` is the airgapped/manual path.
    Init {
        /// Read the TOML from this file instead of stdin. Use `-` for stdin.
        #[arg(long)]
        from_file: Option<PathBuf>,
        /// Override the write target.
        #[arg(long)]
        to: Option<PathBuf>,
        /// Replace an existing config file.
        #[arg(long)]
        overwrite: bool,
    },
    /// Preflight: validate config, send a real heartbeat, report clock skew
    /// with actionable hints. Run this after `init` and before `run`.
    Doctor,
    /// One-shot: load snapshots from a JSON file and push them.
    Push {
        /// JSON file containing an array of FileSnapshot objects.
        #[arg(short, long)]
        snapshots: PathBuf,
        /// Opaque watermark to record on the integration row.
        #[arg(short, long)]
        watermark: Option<String>,
    },
    /// One-shot: upload a single document file against an existing file
    /// number. The companion to `push` for the binary side of the pipeline
    /// — useful for verifying the document wire format end-to-end before
    /// the SQL document-pointer mapping is wired up.
    PushDocument {
        /// Path to the document on disk (PDF, etc.).
        #[arg(long)]
        file: PathBuf,
        /// File number on the server tenant — must already exist (push the
        /// snapshot first via `agent push`).
        #[arg(long)]
        file_number: String,
        /// Document type tag, e.g. purchase_agreement / counter_offer /
        /// lender_instructions. Used to seed the extractor's hint and to
        /// surface in the UI.
        #[arg(long)]
        doc_type: String,
        /// Optional human-readable title; defaults to the file's basename.
        #[arg(long)]
        title: Option<String>,
        /// Optional Content-Type override; defaults to application/pdf.
        #[arg(long)]
        content_type: Option<String>,
        /// Skip the cheap precheck that confirms the file row exists on
        /// the server before shipping the body. Use only when testing the
        /// 404 path or when you've already confirmed externally.
        #[arg(long)]
        skip_precheck: bool,
    },
    /// One-shot heartbeat ping.
    Heartbeat,
    /// Long-running loop: heartbeat + (if [proform] is set) SQL polling,
    /// until SIGINT.
    Run {
        /// Seconds between heartbeats.
        #[arg(long, default_value_t = 60)]
        heartbeat_interval: u64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();

    // `install`/`init` are the only subcommands that run without a valid
    // config — they're the *creators* of the config file. Doctor + the
    // rest go through the standard config-load path.
    match cli.command {
        Command::Install {
            ref token,
            ref server,
            ref to,
            overwrite,
        } => {
            let path = run_install(server, token, to.as_deref(), overwrite).await?;
            println!("Wrote config to {}", path.display());
            println!(
                "Next: run `agent doctor` to verify the agent can reach the server."
            );
            return Ok(());
        }
        Command::Init {
            ref from_file,
            ref to,
            overwrite,
        } => {
            let path = run_init(from_file.as_deref(), to.as_deref(), overwrite)?;
            println!("Wrote config to {}", path.display());
            println!("Next: run `agent doctor` to verify connectivity.");
            return Ok(());
        }
        Command::Doctor => {
            let path = resolve_config_path(cli.config.as_deref());
            let report = run_doctor(&path).await?;
            report.print();
            if !report.is_healthy() {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => {}
    }

    let path = resolve_config_path(cli.config.as_deref());
    let cfg = Config::load(&path)?;
    let proform_cfg = cfg.proform.clone();
    let client = AgentClient::new(cfg)?;

    match cli.command {
        Command::Init { .. } | Command::Install { .. } | Command::Doctor => {
            unreachable!("handled above")
        }
        Command::Push {
            snapshots,
            watermark,
        } => cmd_push(&client, &snapshots, watermark.as_deref()).await,
        Command::PushDocument {
            file,
            file_number,
            doc_type,
            title,
            content_type,
            skip_precheck,
        } => {
            cmd_push_document(
                &client,
                &file,
                &file_number,
                &doc_type,
                title.as_deref(),
                content_type.as_deref(),
                skip_precheck,
            )
            .await
        }
        Command::Heartbeat => cmd_heartbeat(&client).await,
        Command::Run { heartbeat_interval } => {
            cmd_run(&client, heartbeat_interval, proform_cfg).await
        }
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,reqwest=warn,hyper=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

async fn cmd_push(
    client: &AgentClient,
    path: &std::path::Path,
    watermark: Option<&str>,
) -> Result<()> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("reading snapshots at {}", path.display()))?;
    let snapshots: Vec<FileSnapshot> = serde_json::from_str(&raw)
        .with_context(|| format!("parsing snapshots at {}", path.display()))?;
    info!(count = snapshots.len(), "pushing snapshots");

    let res = client.push_snapshots(&snapshots, watermark).await?;
    info!(
        run_id = %res.run_id,
        files_processed = res.files_processed,
        files_upserted = res.files_upserted,
        errors = res.error_count,
        "push succeeded"
    );
    Ok(())
}

async fn cmd_push_document(
    client: &AgentClient,
    path: &std::path::Path,
    file_number: &str,
    doc_type: &str,
    title: Option<&str>,
    content_type: Option<&str>,
    skip_precheck: bool,
) -> Result<()> {
    if !skip_precheck {
        match client.file_exists(file_number).await {
            Ok(true) => {} // fall through to the upload
            Ok(false) => {
                warn!(
                    %file_number,
                    "skipping upload: server has no file row for this fileNumber yet. \
                     Push the snapshot first (agent push --snapshots ...) or pass \
                     --skip-precheck to force.",
                );
                return Ok(());
            }
            Err(e) => {
                warn!(
                    %file_number,
                    "precheck failed: {e:#}. Re-run with --skip-precheck to attempt the upload anyway.",
                );
                return Err(e);
            }
        }
    }

    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("reading document at {}", path.display()))?;
    let title = title
        .map(str::to_string)
        .or_else(|| {
            path.file_name()
                .and_then(|os| os.to_str())
                .map(str::to_string)
        });
    let meta = crate::client::DocumentMeta {
        file_number: file_number.to_string(),
        doc_type: doc_type.to_string(),
        title,
        content_type: content_type.map(str::to_string),
    };
    info!(bytes = bytes.len(), %file_number, %doc_type, "uploading document");
    let res = client.upload_document(&meta, &bytes).await?;
    if res.deduped {
        info!(document_id = %res.document_id, "already on server (deduped)");
    } else {
        info!(
            document_id = %res.document_id,
            extraction_id = ?res.extraction_id,
            "uploaded; extraction scheduled"
        );
    }
    Ok(())
}

async fn cmd_heartbeat(client: &AgentClient) -> Result<()> {
    let res = client.heartbeat().await?;
    info!(server_time = res.server_time, "heartbeat ok");
    Ok(())
}

async fn cmd_run(
    client: &AgentClient,
    heartbeat_interval_secs: u64,
    proform_cfg: Option<crate::config::ProformConfig>,
) -> Result<()> {
    info!(heartbeat_interval_secs, "agent run loop starting");

    // Heartbeat ticker. Spawn the SQL poller separately so a slow ProForm
    // query can't starve the heartbeat — agencies notice "agent offline"
    // dashboards faster than they notice missing data.
    let heartbeat_handle = {
        let client = client.clone();
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(Duration::from_secs(heartbeat_interval_secs));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                match client.heartbeat().await {
                    Ok(_) => info!("heartbeat ok"),
                    Err(e) => warn!("heartbeat failed: {e:#}"),
                }
            }
        })
    };

    let poller_handle = match proform_cfg {
        Some(pc) => {
            info!(
                poll_interval_secs = pc.poll_interval_secs,
                "ProForm poller enabled"
            );
            // initial_watermark could be hydrated via a small server query
            // ("what watermark did this integration last ack?") — TODO once
            // that endpoint exists.
            let poller = ProformPoller::new(pc, None);
            let client = client.clone();
            Some(tokio::spawn(async move {
                if let Err(e) = poller.run_forever(&client).await {
                    warn!("ProForm poller exited: {e:#}");
                }
            }))
        }
        None => {
            info!("no [proform] config — heartbeat-only mode");
            None
        }
    };

    signal::ctrl_c().await.ok();
    info!("shutdown signal received");
    heartbeat_handle.abort();
    if let Some(h) = poller_handle {
        h.abort();
    }
    Ok(())
}

