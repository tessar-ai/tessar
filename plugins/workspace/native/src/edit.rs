use super::{EditReplacement, BOM};
use crate::error::{Failure, Result, INVALID_EDIT};
use std::borrow::Cow;

fn normalize_endings(text: Cow<'_, str>) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        text
    }
}

fn first_ending(text: &str) -> Option<&'static str> {
    let tail = &text[text.find(['\r', '\n'])?..];
    Some(if tail.starts_with("\r\n") {
        "\r\n"
    } else if tail.starts_with('\r') {
        "\r"
    } else {
        "\n"
    })
}

struct Match {
    start: usize,
    end: usize,
    before: String,
    after: String,
}

pub(crate) fn replace(original: &str, edits: &[EditReplacement], path: &str) -> Result<String> {
    let source = original.strip_prefix(BOM).unwrap_or(original);
    let normalized = normalize_endings(Cow::Borrowed(source));
    let removed_offsets = source
        .match_indices("\r\n")
        .enumerate()
        .map(|(removed, (index, _))| index - removed)
        .collect::<Vec<_>>();
    let mut matches = Vec::with_capacity(edits.len());
    for (index, edit) in edits.iter().enumerate() {
        let number = index + 1;
        let before = String::from_utf16(&edit.old_text);
        let after = String::from_utf16(&edit.new_text);
        let (Ok(before), Ok(after)) = (before, after) else {
            return Err(Failure::new(
                INVALID_EDIT,
                format!("Edit {number} must contain valid text: {path}"),
            ));
        };
        let first = before
            .chars()
            .next()
            .filter(|_| !before.contains('\0') && !after.contains('\0'));
        let Some(first) = first else {
            return Err(Failure::new(
                INVALID_EDIT,
                format!("Edit {number} must contain valid text: {path}"),
            ));
        };
        let before = normalize_endings(Cow::Owned(before)).into_owned();
        let after = normalize_endings(Cow::Owned(after)).into_owned();
        let start = normalized.find(&before).ok_or_else(|| {
            Failure::new(
                INVALID_EDIT,
                format!("Edit {number} text was not found: {path}"),
            )
        })?;
        if normalized[start + first.len_utf8()..].contains(&before) {
            return Err(Failure::new(
                INVALID_EDIT,
                format!("Edit {number} text is ambiguous: {path}"),
            ));
        }
        matches.push(Match {
            start,
            end: start + before.len(),
            before,
            after,
        });
    }
    matches.sort_by_key(|edit| edit.start);

    let mut output = String::with_capacity(original.len());
    if original.starts_with(BOM) {
        output.push(BOM);
    }
    let default_ending = first_ending(source).unwrap_or("\n");
    let mut remaining = removed_offsets.into_iter().peekable();
    let mut removed = 0;
    let mut original_offset = |offset| {
        while remaining.peek().is_some_and(|index| *index < offset) {
            remaining.next();
            removed += 1;
        }
        offset + removed
    };

    let mut tail = 0;
    let mut previous_end = 0;
    for edit in matches {
        if edit.start < previous_end {
            return Err(Failure::new(INVALID_EDIT, format!("Edits overlap: {path}")));
        }
        let start = original_offset(edit.start);
        let end = original_offset(edit.end);
        let original_text = &source[start..end];
        output.push_str(&source[tail..start]);
        if edit.before == edit.after {
            output.push_str(original_text);
        } else {
            let ending = first_ending(original_text).unwrap_or(default_ending);
            for (index, line) in edit.after.split('\n').enumerate() {
                if index != 0 {
                    output.push_str(ending);
                }
                output.push_str(line);
            }
        }
        previous_end = edit.end;
        tail = end;
    }
    output.push_str(&source[tail..]);
    if output == original {
        return Err(Failure::new(
            INVALID_EDIT,
            format!("No changes made: {path}"),
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_bom_and_mixed_endings_with_unicode_offsets() -> Result<()> {
        let edits = [EditReplacement {
            old_text: "second\nkeep".to_owned().into(),
            new_text: "new\nkept".to_owned().into(),
        }];
        assert_eq!(
            replace("\u{feff}hi \u{1f642}\r\nsecond\nkeep\r\n", &edits, "file")?,
            "\u{feff}hi \u{1f642}\r\nnew\nkept\r\n",
        );
        Ok(())
    }

    #[test]
    fn rejects_overlapping_occurrences_of_one_match() {
        let edits = [EditReplacement {
            old_text: "aa".to_owned().into(),
            new_text: "b".to_owned().into(),
        }];
        assert!(replace("aaa", &edits, "file").is_err());
    }
}
