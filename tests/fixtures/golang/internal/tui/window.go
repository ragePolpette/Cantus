package tui

import (
	"fmt"

	helpers "example.com/shop/v2/internal/util"
	"os"
)

func Render(item *helpers.Item) string {
	short, _ := helpers.Truncate(item.Text, helpers.Max)
	fmt.Fprintln(os.Stdout, short)
	return short
}
