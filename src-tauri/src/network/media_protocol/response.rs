use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

use tauri::http::{header, response::Builder as ResponseBuilder, Response, StatusCode};

// WRY's Android adapter copies custom-protocol bodies into a JNI byte array, so range
// responses must stay bounded even when WebView asks for the rest of a large video.
pub(super) const MAX_RANGE_CHUNK: u64 = 2 * 1024 * 1024;

enum RangeSelection {
    Partial { start: u64, end: u64 },
    Ignore,
    Unsatisfiable,
}

pub(super) async fn read_full(body_path: PathBuf) -> Result<Vec<u8>, StatusCode> {
    tokio::task::spawn_blocking(move || fs::read(&body_path))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(super) async fn serve_range(
    body_path: PathBuf,
    content_type: String,
    range_header: String,
) -> Result<Response<Vec<u8>>, StatusCode> {
    tokio::task::spawn_blocking(move || {
        let mut file = fs::File::open(&body_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let total = file
            .metadata()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .len();
        let (start, end) = match select_range(&range_header, total) {
            RangeSelection::Partial { start, end } => (start, end),
            RangeSelection::Ignore => {
                let mut body = Vec::new();
                file.read_to_end(&mut body)
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                return Ok(ok_response(body, &content_type));
            }
            RangeSelection::Unsatisfiable => return Ok(range_not_satisfiable(total)),
        };
        let length = end - start + 1;
        let mut body = vec![0; length as usize];
        file.seek(SeekFrom::Start(start))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        file.read_exact(&mut body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok(partial_response(body, &content_type, start, end, total))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

pub(super) fn serve_range_memory(
    body: &[u8],
    content_type: &str,
    range_header: &str,
) -> Response<Vec<u8>> {
    let total = body.len() as u64;
    let (start, end) = match select_range(range_header, total) {
        RangeSelection::Partial { start, end } => (start, end),
        RangeSelection::Ignore => return ok_response(body.to_vec(), content_type),
        RangeSelection::Unsatisfiable => return range_not_satisfiable(total),
    };
    partial_response(
        body[start as usize..=end as usize].to_vec(),
        content_type,
        start,
        end,
        total,
    )
}

#[cfg(test)]
pub(super) fn selected_range(range_header: &str, total: u64) -> Option<(u64, u64)> {
    match select_range(range_header, total) {
        RangeSelection::Partial { start, end } => Some((start, end)),
        _ => None,
    }
}

#[cfg(test)]
pub(super) fn is_unsatisfiable(range_header: &str, total: u64) -> bool {
    matches!(
        select_range(range_header, total),
        RangeSelection::Unsatisfiable
    )
}

fn select_range(range_header: &str, total: u64) -> RangeSelection {
    if total == 0 {
        return RangeSelection::Unsatisfiable;
    }
    let Some(spec) = range_header.strip_prefix("bytes=") else {
        return RangeSelection::Unsatisfiable;
    };
    if spec.contains(',') {
        return RangeSelection::Ignore;
    }
    let Some((start, end)) = spec.trim().split_once('-') else {
        return RangeSelection::Unsatisfiable;
    };
    let (start, end) = if start.is_empty() {
        let Ok(suffix) = end.parse::<u64>() else {
            return RangeSelection::Unsatisfiable;
        };
        if suffix == 0 {
            return RangeSelection::Unsatisfiable;
        }
        let length = suffix.min(total).min(MAX_RANGE_CHUNK);
        (total - length, total - 1)
    } else {
        let Ok(start) = start.parse::<u64>() else {
            return RangeSelection::Unsatisfiable;
        };
        let requested_end = if end.is_empty() {
            total - 1
        } else {
            let Ok(end) = end.parse::<u64>() else {
                return RangeSelection::Unsatisfiable;
            };
            end.min(total - 1)
        };
        let end = requested_end.min(start.saturating_add(MAX_RANGE_CHUNK - 1));
        (start, end)
    };
    if start <= end && start < total {
        RangeSelection::Partial { start, end }
    } else {
        RangeSelection::Unsatisfiable
    }
}

pub(super) fn media_response_builder(status: StatusCode, content_type: &str) -> ResponseBuilder {
    let cache_control = if content_type == "application/octet-stream" {
        "no-store"
    } else {
        "private, max-age=31536000, immutable"
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'; script-src 'none'; object-src 'none'",
        )
}

pub(super) fn ok_response(body: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    let content_length = body.len();
    media_response_builder(StatusCode::OK, content_type)
        .header(header::CONTENT_LENGTH, content_length)
        .body(body)
        .expect("failed to build media response")
}

fn partial_response(
    body: Vec<u8>,
    content_type: &str,
    start: u64,
    end: u64,
    total: u64,
) -> Response<Vec<u8>> {
    let content_length = body.len();
    media_response_builder(StatusCode::PARTIAL_CONTENT, content_type)
        .header(header::CONTENT_LENGTH, content_length)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
        .body(body)
        .expect("failed to build partial media response")
}

pub(super) fn range_not_satisfiable(total: u64) -> Response<Vec<u8>> {
    let mut response = error_response(StatusCode::RANGE_NOT_SATISFIABLE);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_RANGE,
        header::HeaderValue::from_str(&format!("bytes */{total}"))
            .expect("valid 416 content range"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        header::HeaderValue::from_static("0"),
    );
    headers.insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    response
}

pub(super) fn session_unavailable_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::RETRY_AFTER, "1")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("failed to build 503 media response")
}

pub(super) fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("failed to build media error response")
}

fn is_webview_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions) && origin.starts_with("http://localhost:"))
}

pub(super) fn apply_cors_headers(response: &mut Response<Vec<u8>>, request_origin: Option<&str>) {
    let Some(origin) = request_origin.filter(|origin| is_webview_origin(origin)) else {
        return;
    };
    let Ok(value) = header::HeaderValue::from_str(origin) else {
        return;
    };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
}
