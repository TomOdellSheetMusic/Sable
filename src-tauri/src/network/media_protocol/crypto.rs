use std::{collections::HashMap, sync::RwLock};

use aes::{
    cipher::{KeyIvInit, StreamCipher},
    Aes256,
};
use base64::Engine;
use ctr::{Ctr128BE, Ctr64BE};
use sha2::{Digest, Sha256};
use tauri::http::{StatusCode, Uri};
use tauri_plugin_http::reqwest::Url;

const MEDIA_PROTOCOL_PREFIXES: [&str; 3] = [
    "sable-media://",
    "http://sable-media.localhost/",
    "https://sable-media.localhost/",
];

#[derive(Clone)]
struct EncryptionParams {
    key: [u8; 32],
    iv: [u8; 16],
    counter_length: u8,
    expected_sha256: Vec<u8>,
    content_type: String,
}

#[derive(Default)]
pub(super) struct EncryptionStore {
    entries: RwLock<HashMap<String, EncryptionParams>>,
}

impl EncryptionStore {
    pub(super) fn register(
        &self,
        url: &str,
        key: &str,
        iv: &str,
        sha256: &str,
        version: &str,
        content_type: String,
    ) -> Result<(), String> {
        let key_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(key)
            .map_err(|error| format!("invalid key base64url: {error}"))?;
        let key = key_bytes
            .try_into()
            .map_err(|bytes: Vec<u8>| format!("key must be 32 bytes, got {}", bytes.len()))?;

        let iv_bytes = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(iv)
            .map_err(|error| format!("invalid iv base64: {error}"))?;
        let iv = iv_bytes
            .try_into()
            .map_err(|bytes: Vec<u8>| format!("iv must be 16 bytes, got {}", bytes.len()))?;

        let expected_sha256 = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(sha256)
            .map_err(|error| format!("invalid sha256 base64: {error}"))?;

        let params = EncryptionParams {
            key,
            iv,
            counter_length: if matches!(version, "v1" | "v2") {
                64
            } else {
                128
            },
            expected_sha256,
            content_type,
        };

        self.entries
            .write()
            .map_err(|_| "encryption lock poisoned".to_owned())?
            .insert(normalize_key(url), params);
        Ok(())
    }

    pub(super) fn clear(&self) {
        if let Ok(mut entries) = self.entries.write() {
            entries.clear();
        }
    }

    pub(super) fn contains(&self, url: &str) -> bool {
        self.entries
            .read()
            .map(|entries| entries.contains_key(url))
            .unwrap_or(false)
    }

    pub(super) fn decrypt(
        &self,
        url: &str,
        ciphertext: Vec<u8>,
        upstream_content_type: &str,
    ) -> Result<(Vec<u8>, String), StatusCode> {
        let params = self
            .entries
            .read()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .get(url)
            .cloned();

        let Some(params) = params else {
            return Ok((ciphertext, upstream_content_type.to_owned()));
        };

        if Sha256::digest(&ciphertext).as_slice() != params.expected_sha256 {
            return Err(StatusCode::BAD_GATEWAY);
        }

        let mut plaintext = ciphertext;
        match params.counter_length {
            64 => Ctr64BE::<Aes256>::new((&params.key).into(), (&params.iv).into())
                .apply_keystream(&mut plaintext),
            128 => Ctr128BE::<Aes256>::new((&params.key).into(), (&params.iv).into())
                .apply_keystream(&mut plaintext),
            _ => return Err(StatusCode::BAD_REQUEST),
        }

        let content_type = if params.content_type.is_empty()
            || params.content_type == "application/octet-stream"
        {
            sniff_image_content_type(&plaintext)
                .map(str::to_owned)
                .unwrap_or(params.content_type)
        } else {
            params.content_type
        };
        Ok((plaintext, content_type))
    }
}

pub(super) fn normalize_key(url: &str) -> String {
    if MEDIA_PROTOCOL_PREFIXES
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        if let Ok(uri) = Uri::try_from(url) {
            let path = uri.path().trim_start_matches('/');
            let decoded = percent_encoding::percent_decode_str(path)
                .decode_utf8()
                .unwrap_or(std::borrow::Cow::Borrowed(path));
            if let Ok(mut parsed) = Url::parse(&decoded) {
                parsed.set_fragment(None);
                return parsed.to_string();
            }
            return decoded.into_owned();
        }
    }

    Url::parse(url)
        .map(|mut parsed| {
            parsed.set_fragment(None);
            parsed.to_string()
        })
        .unwrap_or_else(|_| url.to_owned())
}

pub(super) fn sniff_image_content_type(bytes: &[u8]) -> Option<&'static str> {
    const ALLOWED: [&str; 5] = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
    ];
    infer::get(bytes)
        .filter(|kind| ALLOWED.contains(&kind.mime_type()))
        .map(|kind| kind.mime_type())
}
