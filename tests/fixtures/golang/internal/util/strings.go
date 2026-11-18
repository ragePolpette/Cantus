// Package util has small helpers.
package util

import "strings"

// Truncate shortens a string to limit runes.
func Truncate(input string, limit int) (string, bool) {
	runes := []rune(strings.TrimSpace(input))
	if len(runes) <= limit {
		return input, false
	}
	return string(runes[:limit]), true
}

func hidden() {}
