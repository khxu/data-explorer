use std::collections::HashSet;

use serde_json::Value;

pub fn extract_placeholders(template: &str) -> Vec<String> {
    let mut placeholders = Vec::new();
    let mut seen = HashSet::new();
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("}}") else {
            break;
        };
        let candidate = after_start[..end].trim();
        if is_placeholder_name(candidate) && seen.insert(candidate.to_string()) {
            placeholders.push(candidate.to_string());
        }
        rest = &after_start[end + 2..];
    }

    placeholders
}

pub fn interpolate(template: &str, row: &serde_json::Map<String, Value>) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };

        let raw_placeholder = &after_start[..end];
        let key = raw_placeholder.trim();
        if is_placeholder_name(key) {
            if let Some(value) = row.get(key) {
                output.push_str(&value_to_prompt_text(value));
            } else {
                output.push_str("{{");
                output.push_str(raw_placeholder);
                output.push_str("}}");
            }
        } else {
            output.push_str("{{");
            output.push_str(raw_placeholder);
            output.push_str("}}");
        }
        rest = &after_start[end + 2..];
    }

    output.push_str(rest);
    output
}

fn is_placeholder_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn value_to_prompt_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_unique_placeholders_in_order() {
        assert_eq!(
            extract_placeholders("A {{ name }} {{age}} {{name}} {{not valid}}"),
            vec!["name".to_string(), "age".to_string()]
        );
    }

    #[test]
    fn interpolates_known_values_and_preserves_unknowns() {
        let mut row = serde_json::Map::new();
        row.insert("name".to_string(), Value::String("Ada".to_string()));
        row.insert("score".to_string(), serde_json::json!(42));
        row.insert("empty".to_string(), Value::Null);

        assert_eq!(
            interpolate("{{name}} scored {{ score }}. {{missing}} {{empty}}", &row),
            "Ada scored 42. {{missing}} "
        );
    }
}
