use sqlx::PgPool;
use uuid::Uuid;

pub struct Job {
    pub id: Uuid,
    pub album_artist: String,
    pub album: String,
    /// How long the row sat PENDING before this claim — distinguishes queue latency from
    /// download latency in traces.
    pub wait_seconds: f64,
}

/// Requeue rows left IN_PROGRESS by a previous run. This worker is the only claimer, so at
/// startup any IN_PROGRESS row is an orphan from a crash or kill mid-download.
pub async fn reset_stale(pool: &PgPool) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r#"UPDATE "AlbumArt" SET status = 'PENDING', "updatedAt" = now() WHERE status = 'IN_PROGRESS'"#,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Claim the oldest PENDING row, marking it IN_PROGRESS. SKIP LOCKED keeps concurrent claims
/// from blocking on each other.
#[tracing::instrument(name = "db.claim_next", skip_all)]
pub async fn claim_next(pool: &PgPool) -> sqlx::Result<Option<Job>> {
    // RETURNING sees the post-update row, so the time the row sat PENDING (it became PENDING at
    // its previous "updatedAt") is carried through the locking subquery instead.
    let row: Option<(Uuid, String, String, f64)> = sqlx::query_as(
        r#"
        UPDATE "AlbumArt" a SET status = 'IN_PROGRESS', "updatedAt" = now()
        FROM (
          SELECT id, "updatedAt" FROM "AlbumArt" WHERE status = 'PENDING'
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
        ) prev
        WHERE a.id = prev.id
        RETURNING a.id, a."albumArtist", a.album,
          extract(epoch from (now() - prev."updatedAt"))::float8
        "#,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, album_artist, album, wait_seconds)| Job {
        id,
        album_artist,
        album,
        wait_seconds,
    }))
}

#[tracing::instrument(name = "db.mark_succeeded", skip_all)]
pub async fn mark_succeeded(pool: &PgPool, id: Uuid, file: &str) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE "AlbumArt" SET status = 'SUCCEEDED', file = $2, error = null, "updatedAt" = now() WHERE id = $1"#,
    )
    .bind(id)
    .bind(file)
    .execute(pool)
    .await?;
    Ok(())
}

#[tracing::instrument(name = "db.mark_failed", skip_all)]
pub async fn mark_failed(pool: &PgPool, id: Uuid, error: &str) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE "AlbumArt" SET status = 'FAILED', error = $2, "updatedAt" = now() WHERE id = $1"#,
    )
    .bind(id)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}
