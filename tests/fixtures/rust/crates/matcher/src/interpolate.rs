/// Replaces `$name` in a template.
pub fn interpolate(template: &str, name: &str) -> String {
    template.replace("$name", name)
}
