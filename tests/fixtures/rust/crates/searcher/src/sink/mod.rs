use super::Searcher;
use crate::sink::lines::Lines;

mod lines;

pub trait Sink {
    fn matched(&mut self, searcher: &Searcher, line: &Lines) -> bool;
}
