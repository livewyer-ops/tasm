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

fn timestamp(value: &str) -> Result<i128, ValidationError> {
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
        let point = value
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .ok_or(ValidationError)?;
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
        _ if left_value.is_empty() => ('[', ""),
        _ => return Err(ValidationError),
    };
    let (right, end) = match right_value.as_bytes().last().copied() {
        Some(b']') => (']', &right_value[..right_value.len() - 1]),
        Some(b')') => (')', &right_value[..right_value.len() - 1]),
        _ if right_value.is_empty() => (')', ""),
        _ => return Err(ValidationError),
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
