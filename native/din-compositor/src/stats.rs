//! DIN_COMPOSITOR_STATS=1: every two seconds, report to stderr how many
//! batches went out, how many bytes, and how long rendering them took -
//! enough to tell whether the compositor or something downstream is the
//! bottleneck.

use std::time::{Duration, Instant};

pub struct Stats {
    since: Instant,
    batches: u32,
    bytes: usize,
    busy: Duration,
}

impl Stats {
    pub fn from_env() -> Option<Self> {
        (std::env::var("DIN_COMPOSITOR_STATS").as_deref() == Ok("1")).then(|| Self {
            since: Instant::now(),
            batches: 0,
            bytes: 0,
            busy: Duration::ZERO,
        })
    }

    pub fn record(&mut self, bytes: usize, busy: Duration) {
        self.batches += 1;
        self.bytes += bytes;
        self.busy += busy;
        let elapsed = self.since.elapsed();
        if elapsed >= Duration::from_secs(2) {
            let secs = elapsed.as_secs_f64();
            eprintln!(
                "din-compositor: {:.1} batch/s, {:.1} MB/s, rendering {:.0}% of the time",
                self.batches as f64 / secs,
                self.bytes as f64 / secs / 1e6,
                self.busy.as_secs_f64() / secs * 100.0,
            );
            *self = Self { since: Instant::now(), batches: 0, bytes: 0, busy: Duration::ZERO };
        }
    }
}
