use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use sacad::cl::{ImageProcessingArgs, SearchOptions, SearchQuery};
use sacad::SearchStatus;

pub use sacad::cl::SourceName;

/// The default cover sources. Cover Art Archive is excluded: its MusicBrainz lookups are
/// rate-limited to one request per second, and a single search burns ~10s waiting on them while
/// the reference image almost always comes from iTunes anyway.
pub fn default_sources() -> Vec<SourceName> {
    vec![
        SourceName::Deezer,
        SourceName::Discogs,
        SourceName::Itunes,
        SourceName::LastFm,
    ]
}

/// Parse a comma-separated source list (the names the sacad CLI uses, e.g.
/// `itunes,deezer,coverartarchive`). Unknown names and an empty list are errors — a worker
/// silently searching nothing would fail every row with "no cover found".
pub fn parse_sources(value: &str) -> anyhow::Result<Vec<SourceName>> {
    let sources = value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<SourceName>()
                .map_err(|_| anyhow::anyhow!("unknown cover source: {s}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(!sources.is_empty(), "no cover sources configured");
    Ok(sources)
}

/// Search for a cover with the sacad library and write it to `out`. The crate's API is
/// documented as internal to its binaries, hence the exact version pin in Cargo.toml.
#[tracing::instrument(name = "sacad.search_and_download", skip_all)]
pub async fn download(
    album_artist: &str,
    album: &str,
    size: u32,
    sources: &[SourceName],
    out: &Path,
    timeout: Duration,
) -> anyhow::Result<()> {
    let query = Arc::new(SearchQuery {
        artist: Some(album_artist.to_owned()),
        album: album.to_owned(),
    });
    // 25% size tolerance and jpg conversion match the sacad CLI defaults. The sources must be
    // listed explicitly — an empty vec means none at the library level; the empty-means-all
    // behaviour is CLI argument handling.
    let opts = Arc::new(SearchOptions {
        size,
        size_tolerance_prct: 25,
        cover_sources: sources.to_vec(),
    });
    let image_proc = ImageProcessingArgs {
        preserve_format: false,
    };

    let status = tokio::time::timeout(
        timeout,
        sacad::search_and_download(out, query, opts, &image_proc),
    )
    .await
    .context("search timed out")?
    .map_err(|err| anyhow::anyhow!("{err:#}"))?;

    match status {
        SearchStatus::Found => Ok(()),
        SearchStatus::NotFound => anyhow::bail!("no cover found"),
    }
}
