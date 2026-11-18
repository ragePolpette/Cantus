use shop_matcher::{interpolate, Match as Hit, Matcher};
use shop_searcher::reexported::MAX_MATCHES;
use shop_searcher::{Searcher, Sink};
use std::collections::HashMap;

struct Exact;

impl Matcher for Exact {
    fn find(&self, haystack: &[u8]) -> Option<Hit> {
        Some(Hit::new(0, haystack.len()))
    }
}

fn main() {
    let searcher = Searcher::new();
    let found = searcher.search(&Exact, b"abc");
    println!("{} {:?} {}", interpolate("$name", "x"), found, MAX_MATCHES);
    let _: HashMap<u8, u8> = HashMap::new();
}
