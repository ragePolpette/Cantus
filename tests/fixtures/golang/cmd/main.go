package main

import (
	"example.com/shop/v2/internal/tui"
	"example.com/shop/v2/internal/util"
)

func main() {
	item := &util.Item{Text: "x"}
	tui.Render(item)
	util := 3
	_ = util
}
