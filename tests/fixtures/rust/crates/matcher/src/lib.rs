//! Matching.
mod interpolate;

pub use crate::interpolate::interpolate;

/// A match: a range of bytes.
///
/// Always `start <= end`.
#[derive(Clone, Copy, Debug)]
pub struct Match {
    pub start: usize,
    end: usize,
}

impl Match {
    /// Builds a match.
    pub fn new(start: usize, end: usize) -> Match {
        Match { start, end }
    }

    pub fn len(&self) -> usize {
        self.end - self.start
    }

    fn check(&self) {}
}

pub trait Matcher {
    fn find(&self, haystack: &[u8]) -> Option<Match>;
}

pub const MAX_MATCHES: usize = 1000;

#[cfg(test)]
mod tests {
    use super::Match;
}
