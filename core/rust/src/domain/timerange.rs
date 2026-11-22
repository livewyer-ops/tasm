// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use super::ValidationError;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bounds {
    pub start: Option<i128>,
    pub end: Option<i128>,
    pub empty: bool,
    pub point: bool,
}

const NANOS_PER_SECOND: i128 = 1_000_000_000;

fn integer(value: &str, signed: bool) -> Result<i128, ValidationError> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty()
        || (!signed && value.starts_with('-'))
        || (digits.len() > 1 && digits.starts_with('0'))
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ValidationError);
    }
    value.parse().map_err(|_| ValidationError)
}

/// Parses a TAMS timestamp such as `10:0` or `-1:500` into nanoseconds.
pub fn timestamp(value: &str) -> Result<i128, ValidationError> {
    let (seconds, nanos) = value.split_once(':').ok_or(ValidationError)?;
    let negative = seconds.starts_with('-');
    let seconds = integer(seconds.strip_prefix('-').unwrap_or(seconds), false)?;
    let nanos = integer(nanos, false)?;
    if nanos >= NANOS_PER_SECOND {
        return Err(ValidationError);
    }
    let magnitude = seconds
        .checked_mul(NANOS_PER_SECOND)
        .and_then(|value| value.checked_add(nanos))
        .ok_or(ValidationError)?;
    Ok(if negative { -magnitude } else { magnitude })
}

pub fn parse(value: &str) -> Result<Bounds, ValidationError> {
    if value.is_empty() || value == "_" {
        return Ok(Bounds::default());
    }
    if value == "()" {
        return Ok(Bounds {
            empty: true,
            ..Bounds::default()
        });
    }

    if !value.contains('_') {
        // A single timestamp may carry inclusive markers or none (TAMS appnote 0008).
        let point = match value.strip_prefix('[') {
            Some(inner) => inner.strip_suffix(']').ok_or(ValidationError)?,
            None if !value.ends_with(']') => value,
            None => return Err(ValidationError),
        };
        let point = timestamp(point)?;
        return Ok(Bounds {
            start: Some(point),
            end: Some(point),
            point: true,
            ..Bounds::default()
        });
    }

    let (left_value, right_value) = value.split_once('_').ok_or(ValidationError)?;
    let (left, start) = match left_value.as_bytes().first().copied() {
        Some(b'[') => ('[', &left_value[1..]),
        Some(b'(') => ('(', &left_value[1..]),
        // A finite bound without a marker is inclusive.
        _ => ('[', left_value),
    };
    let (right, end) = match right_value.as_bytes().last().copied() {
        Some(b']') => (']', &right_value[..right_value.len() - 1]),
        Some(b')') => (')', &right_value[..right_value.len() - 1]),
        _ => (']', right_value),
    };
    let start = (!start.is_empty()).then(|| timestamp(start)).transpose()?;
    let end = (!end.is_empty()).then(|| timestamp(end)).transpose()?;
    let point = start.is_some() && start == end && left == '[' && right == ']';
    if point {
        return Ok(Bounds {
            start,
            end,
            point: true,
            empty: false,
        });
    }
    let start = start
        .map(|value| {
            if left == '(' {
                value.checked_add(1).ok_or(ValidationError)
            } else {
                Ok(value)
            }
        })
        .transpose()?;
    let end = end
        .map(|value| {
            if right == ']' {
                value.checked_add(1).ok_or(ValidationError)
            } else {
                Ok(value)
            }
        })
        .transpose()?;
    let empty = start.zip(end).is_some_and(|(start, end)| start >= end) && !point;
    Ok(Bounds {
        start,
        end,
        empty,
        point,
    })
}

/// Make omitted finite bounds explicit before a range crosses the storage boundary.
/// Older records used an exclusive omitted end. Points have no ambiguous bounds.
pub fn explicit(value: &str, omitted_end: char) -> std::borrow::Cow<'_, str> {
    let Some((left, right)) = value.split_once('_') else {
        return value.into();
    };
    let add_start = !left.is_empty() && !left.starts_with(['[', '(']);
    let add_end = !right.is_empty() && !right.ends_with([']', ')']);
    if !add_start && !add_end {
        return value.into();
    }
    let mut text = String::with_capacity(value.len() + 2);
    if add_start {
        text.push('[');
    }
    text.push_str(value);
    if add_end {
        text.push(omitted_end);
    }
    text.into()
}

pub fn format_timestamp(value: i128) -> String {
    let magnitude = value.unsigned_abs();
    format!(
        "{}{}:{}",
        if value < 0 { "-" } else { "" },
        magnitude / NANOS_PER_SECOND as u128,
        magnitude % NANOS_PER_SECOND as u128
    )
}

pub fn from_bounds(start: Option<i128>, end: Option<i128>) -> String {
    match (start, end) {
        (Some(start), Some(end)) => {
            format!("[{}_{})", format_timestamp(start), format_timestamp(end))
        }
        (Some(start), None) => format!("[{}_", format_timestamp(start)),
        (None, Some(end)) => format!("_{})", format_timestamp(end)),
        (None, None) => "()".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i128 = NANOS_PER_SECOND;

    #[test]
    fn parses_bounds_and_clusivity() {
        let range = parse("[1:0_2:0)").unwrap();
        assert_eq!(
            (range.start, range.end, range.point, range.empty),
            (Some(S), Some(2 * S), false, false)
        );
        let range = parse("(1:0_2:0]").unwrap();
        assert_eq!((range.start, range.end), (Some(S + 1), Some(2 * S + 1)));
        assert_eq!(parse("[-1:500_").unwrap().start, Some(-S - 500));
        assert_eq!(parse("_2:0)").unwrap().end, Some(2 * S));
        assert!(parse("[2:0_1:0)").unwrap().empty);
        assert!(parse("()").unwrap().empty);
        assert_eq!(parse("_").unwrap(), Bounds::default());
    }

    #[test]
    fn accepts_omitted_markers() {
        // TAMS appnote 0008: markers may be omitted; a bare timestamp is a point.
        let point = parse("10:0").unwrap();
        assert!(point.point);
        assert_eq!(point.start, Some(10 * S));
        assert_eq!(parse("0:0_10:0").unwrap(), parse("[0:0_10:0]").unwrap());
        assert_eq!(parse("0:0_").unwrap(), parse("[0:0_").unwrap());
        assert_eq!(parse("_10:0").unwrap(), parse("_10:0]").unwrap());
        assert_eq!(parse("[1:0_2:0").unwrap(), parse("[1:0_2:0]").unwrap());
    }

    #[test]
    fn rejects_malformed_values() {
        for value in [
            "[1:0",
            "1:0]",
            "[01:0]",
            "[1:1000000000]",
            "[a:0]",
            "[1_2]",
            "[1:-1]",
        ] {
            assert!(parse(value).is_err(), "{value} must be rejected");
        }
        assert!(timestamp("1:0_2:0").is_err());
        assert!(timestamp("[1:0]").is_err());
        assert_eq!(timestamp("-2:5").unwrap(), -2 * S - 5);
    }

    #[test]
    fn formats_and_round_trips() {
        assert_eq!(format_timestamp(-S - 5), "-1:5");
        for (start, end) in [
            (Some(S), Some(2 * S)),
            (Some(-S), None),
            (None, Some(3 * S)),
        ] {
            let text = from_bounds(start, end);
            let parsed = parse(&text).unwrap();
            assert_eq!((parsed.start, parsed.end), (start, end), "{text}");
        }
        assert_eq!(from_bounds(None, None), "()");
    }
}
