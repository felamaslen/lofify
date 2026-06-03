use sqlx::PgPool;
use uuid::Uuid;

pub struct Job {
    pub id: Uuid,
    pub album_artist: String,
    pub album: String,
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
pub async fn claim_next(pool: &PgPool) -> sqlx::Result<Option<Job>> {
    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        r#"
        UPDATE "AlbumArt" SET status = 'IN_PROGRESS', "updatedAt" = now()
        WHERE id = (
          SELECT id FROM "AlbumArt" WHERE status = 'PENDING'
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, "albumArtist", album
        "#,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, album_artist, album)| Job {
        id,
        album_artist,
        album,
    }))
}

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
