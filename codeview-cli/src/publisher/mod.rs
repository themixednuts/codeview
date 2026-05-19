//! Cron pipeline core — fetch from docs.rs, parse via codeview-rustdoc,
//! build static artifacts, upload to R2, record freshness.
//!
//! Replaces the TS `scripts/` directory entirely.  One language, one set
//! of types, one parser.  The SvelteKit worker is the only TS that
//! touches R2 in production, and it reads only.
//!
//! Module map:
//!
//! | Module     | Responsibility                                            |
//! |------------|-----------------------------------------------------------|
//! | `r2`       | `R2 trait` + S3 + LocalMiniflare adapters (real seam).    |
//! | `freshness`| `FreshnessRegistry` — "have we parsed this version?".      |
//! | `shards`   | Sharded artifact builders (manifest, nodes, search…).     |
//! | `docs_rs`  | Fetch + decompress rustdoc JSON for `{name}@{version}`.    |
//! | `crates_io`| Newest-version + top-N lookups against the registry.       |
//! | `artifacts`| Build + upload one crate's full artifact set.             |

pub mod artifacts;
pub mod crates_io;
pub mod docs_rs;
pub mod freshness;
pub mod r2;
pub mod shards;
