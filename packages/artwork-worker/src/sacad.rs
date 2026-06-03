use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use sacad::cl::{ImageProcessingArgs, SearchOptions, SearchQuery, SourceName};
use sacad::SearchStatus;

/// Search for a cover with the sacad library and write it to `out`. The crate's API is
/// documented as internal to its binaries, hence the exact version pin in Cargo.toml.
pub async fn download(
    album_artist: &str,
    album: &str,
    size: u32,
    out: &Path,
    timeout: Duration,
) -> anyhow::Result<()> {
    let query = Arc::new(SearchQuery {
        artist: Some(album_artist.to_owned()),
        album: album.to_owned(),
    });
    // Defaults matching the sacad CLI: 25% size tolerance, every cover source, convert to jpg.
    // The sources must be listed explicitly — an empty vec means none at the library level;
    // the empty-means-all behaviour is CLI argument handling.
    let opts = Arc::new(SearchOptions {
        size,
        size_tolerance_prct: 25,
        cover_sources: vec![
            SourceName::CoverArtArchive,
            SourceName::Deezer,
            SourceName::Discogs,
            SourceName::Itunes,
            SourceName::LastFm,
        ],
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
