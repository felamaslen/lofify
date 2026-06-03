mod db;
mod sacad;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use std::{env, fs};

use anyhow::Context;
use sqlx::postgres::{PgListener, PgPoolOptions};
use sqlx::PgPool;
use tokio::sync::{Notify, Semaphore};
use tracing::{error, info, warn};

/// Fired by the `AlbumArt_pending_notify` trigger whenever a row becomes PENDING.
const NOTIFY_CHANNEL: &str = "album_art_pending";

struct Config {
    artwork_dir: PathBuf,
    size: u32,
    timeout: Duration,
}

fn env_parsed<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Crash-fast when the artwork directory cannot be written: a worker that cannot store images
/// would otherwise claim every row and fail it.
fn ensure_writable(dir: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".write-probe-{}", std::process::id()));
    fs::write(&probe, b"")?;
    fs::remove_file(&probe)?;
    Ok(())
}

/// Wire `tracing` to stdout and, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, to an OTLP trace
/// exporter. Returns the provider so `main` can flush it on shutdown.
fn init_tracing() -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    use opentelemetry::trace::TracerProvider as _;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let provider = env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok().map(|_| {
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .build()
            .expect("failed to build OTLP span exporter");
        opentelemetry_sdk::trace::SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(
                opentelemetry_sdk::Resource::builder()
                    .with_service_name("lofify-artwork-worker")
                    .build(),
            )
            .build()
    });
    let otel_layer = provider
        .as_ref()
        .map(|p| tracing_opentelemetry::layer().with_tracer(p.tracer("artwork-worker")));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(otel_layer)
        .init();
    provider
}

/// Telemetry is initialised outside the async runtime: the OTLP exporter's blocking HTTP client
/// panics when constructed inside one. The provider is shut down after the runtime exits so
/// pending spans flush.
fn main() -> anyhow::Result<()> {
    let provider = init_tracing();
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run());
    if let Some(provider) = provider {
        if let Err(err) = provider.shutdown() {
            warn!("failed to flush traces on shutdown: {err}");
        }
    }
    result
}

async fn run() -> anyhow::Result<()> {
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let disk_cache_dir = env::var("DISK_CACHE_DIR").context("DISK_CACHE_DIR is required")?;
    let artwork_dir = PathBuf::from(disk_cache_dir).join("artwork");
    ensure_writable(&artwork_dir).context("artwork directory is not writable")?;

    let max_parallel: usize = env_parsed("ARTWORK_MAX_PARALLEL", 2);
    let poll_seconds: u64 = env_parsed("ARTWORK_POLL_SECONDS", 30);
    let config = Arc::new(Config {
        artwork_dir,
        size: env_parsed("ARTWORK_SIZE", 600),
        timeout: Duration::from_secs(env_parsed("ARTWORK_TIMEOUT_SECONDS", 120)),
    });

    let pool = PgPoolOptions::new()
        .max_connections(max_parallel as u32 + 1)
        .connect(&database_url)
        .await
        .context("failed to connect to postgres")?;

    let stale = db::reset_stale(&pool).await?;
    if stale > 0 {
        info!("requeued {stale} rows left in progress by a previous run");
    }

    let wake = Arc::new(Notify::new());

    tokio::spawn(listen(pool.clone(), wake.clone()));
    tokio::spawn(tick(wake.clone(), Duration::from_secs(poll_seconds)));

    // Docker stops with SIGTERM; without a handler the process dies before the span exporter flushes (and before a clean shutdown generally).
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

    info!("artwork worker ready");
    let semaphore = Arc::new(Semaphore::new(max_parallel));
    loop {
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::signal::ctrl_c() => break,
            _ = sigterm.recv() => break,
        }
        drain(&pool, &semaphore, &config).await;
    }
    // Let in-flight downloads finish (their rows are IN_PROGRESS and would otherwise wait for
    // the next start's requeue) before the runtime is torn down.
    let _ = semaphore.acquire_many(max_parallel as u32).await;
    info!("shutting down");
    Ok(())
}

/// Claim and process rows until the queue is empty, running up to `max_parallel` downloads at
/// once. In-flight rows are IN_PROGRESS, so the claim loop never sees them twice.
async fn drain(pool: &PgPool, semaphore: &Arc<Semaphore>, config: &Arc<Config>) {
    loop {
        let Ok(permit) = semaphore.clone().acquire_owned().await else {
            return;
        };
        match db::claim_next(pool).await {
            Ok(Some(job)) => {
                let pool = pool.clone();
                let config = config.clone();
                tokio::spawn(async move {
                    process(&pool, &config, job).await;
                    drop(permit);
                });
            }
            Ok(None) => return,
            Err(err) => {
                error!("failed to claim next row: {err}");
                return;
            }
        }
    }
}

#[tracing::instrument(
    name = "artwork.process",
    skip_all,
    fields(
        album_art.id = %job.id,
        album_art.album = %job.album,
        album_art.album_artist = %job.album_artist,
        album_art.queue_wait_seconds = job.wait_seconds,
    )
)]
async fn process(pool: &PgPool, config: &Config, job: db::Job) {
    let file = format!("{}.jpg", job.id);
    let out = config.artwork_dir.join(&file);
    info!(
        "downloading cover for \"{}\" by {}",
        job.album, job.album_artist
    );
    let result = sacad::download(
        &job.album_artist,
        &job.album,
        config.size,
        &out,
        config.timeout,
    )
    .await;
    let update = match result {
        Ok(()) => {
            info!("downloaded {file}");
            db::mark_succeeded(pool, job.id, &file).await
        }
        Err(err) => {
            warn!(
                "download failed for \"{}\" by {}: {err:#}",
                job.album, job.album_artist
            );
            db::mark_failed(pool, job.id, &format!("{err:#}")).await
        }
    };
    if let Err(err) = update {
        error!("failed to update row {}: {err}", job.id);
    }
}

/// Wake the drain loop on every NOTIFY. Connection drops are logged and retried; the poll tick
/// covers anything missed in the gap.
async fn listen(pool: PgPool, wake: Arc<Notify>) {
    loop {
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => l,
            Err(err) => {
                warn!("listener connect failed, retrying: {err}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        if let Err(err) = listener.listen(NOTIFY_CHANNEL).await {
            warn!("LISTEN failed, retrying: {err}");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }
        loop {
            match listener.recv().await {
                Ok(_) => wake.notify_one(),
                Err(err) => {
                    warn!("listener dropped, reconnecting: {err}");
                    break;
                }
            }
        }
    }
}

/// Fallback sweep: NOTIFY is fire-and-forget, so rows inserted while the worker is down (or a
/// dropped notification) are only picked up by polling.
async fn tick(wake: Arc<Notify>, every: Duration) {
    let mut interval = tokio::time::interval(every);
    loop {
        interval.tick().await;
        wake.notify_one();
    }
}
