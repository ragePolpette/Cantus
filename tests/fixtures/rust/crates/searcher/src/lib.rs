mod sink;

use matcher::{Match, Matcher};

pub use crate::sink::Sink;
pub use matcher as reexported;

pub struct Searcher {
    pub limit: usize,
}

impl Searcher {
    pub fn new() -> Searcher {
        Searcher { limit: matcher::MAX_MATCHES }
    }

    pub fn search<M: Matcher>(&self, m: &M, haystack: &[u8]) -> Option<Match> {
        m.find(haystack)
    }
}
