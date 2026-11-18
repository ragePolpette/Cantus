package util

// Item is one entry.
type Item struct {
	Text  string
	index int
}

// Len is the length of the text.
func (item *Item) Len() int { return len(item.Text) }

func (item *Item) private() {}

type Reader interface {
	Read() (string, error)
}

const Max = 3

var Debug bool
