use std::collections::BTreeSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const KEYCHAIN_SERVICE: &str = "com.khxu.data-explorer";
const KEYCHAIN_ACCOUNT: &str = "openai-api-key";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const OPENAI_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
pub struct OpenAiCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorResponse {
    error: Option<OpenAiErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorDetail {
    message: Option<String>,
}

fn keychain_entry() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| AppError::General(format!("Unable to access the OS keychain: {error}")))
}

fn read_api_key() -> Result<Option<String>, AppError> {
    match keychain_entry()?.get_password() {
        Ok(key) if key.trim().is_empty() => Ok(None),
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(AppError::General(format!(
            "Unable to read the OpenAI API key from the OS keychain: {error}"
        ))),
    }
}

#[tauri::command]
pub fn get_openai_credential_status() -> Result<OpenAiCredentialStatus, AppError> {
    Ok(OpenAiCredentialStatus {
        configured: read_api_key()?.is_some(),
    })
}

#[tauri::command]
pub fn set_openai_api_key(api_key: String) -> Result<OpenAiCredentialStatus, AppError> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::General(
            "Enter an OpenAI API key before saving.".to_string(),
        ));
    }

    keychain_entry()?.set_password(api_key).map_err(|error| {
        AppError::General(format!(
            "Unable to save the OpenAI API key in the OS keychain: {error}"
        ))
    })?;
    Ok(OpenAiCredentialStatus { configured: true })
}

#[tauri::command]
pub fn delete_openai_api_key() -> Result<OpenAiCredentialStatus, AppError> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(OpenAiCredentialStatus { configured: false }),
        Err(error) => Err(AppError::General(format!(
            "Unable to remove the OpenAI API key from the OS keychain: {error}"
        ))),
    }
}

#[tauri::command]
pub async fn list_openai_models() -> Result<Vec<String>, AppError> {
    let api_key = read_api_key()?.ok_or_else(|| {
        AppError::General("Save an OpenAI API key before refreshing models.".to_string())
    })?;
    let client = reqwest::Client::builder()
        .timeout(OPENAI_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| {
            AppError::General(format!("Unable to initialize OpenAI client: {error}"))
        })?;
    let response = client
        .get(OPENAI_MODELS_URL)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                AppError::General("OpenAI model discovery timed out.".to_string())
            } else {
                AppError::General(format!("Unable to fetch OpenAI models: {error}"))
            }
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        AppError::General(format!(
            "Unable to read the OpenAI models response: {error}"
        ))
    })?;

    if !status.is_success() {
        let detail = parse_openai_error(&body);
        let message = match status.as_u16() {
            401 => "OpenAI rejected the saved API key.".to_string(),
            429 => "OpenAI rate-limited the model discovery request.".to_string(),
            _ => format!("OpenAI model discovery failed with HTTP {status}."),
        };
        return Err(AppError::General(match detail {
            Some(detail) => format!("{message} {detail}"),
            None => message,
        }));
    }

    parse_model_ids(&body)
}

fn parse_model_ids(body: &str) -> Result<Vec<String>, AppError> {
    let response: OpenAiModelsResponse = serde_json::from_str(body).map_err(|error| {
        AppError::General(format!(
            "OpenAI returned an invalid models response: {error}"
        ))
    })?;
    Ok(response
        .data
        .into_iter()
        .map(|model| model.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

fn parse_openai_error(body: &str) -> Option<String> {
    serde_json::from_str::<OpenAiErrorResponse>(body)
        .ok()?
        .error?
        .message
        .filter(|message| !message.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sorts_and_deduplicates_model_ids() {
        let models = parse_model_ids(
            r#"{"data":[{"id":"gpt-z"},{"id":"gpt-a"},{"id":"gpt-z"},{"id":"  "}]}"#,
        )
        .unwrap();

        assert_eq!(models, vec!["gpt-a", "gpt-z"]);
    }

    #[test]
    fn rejects_invalid_model_response() {
        assert!(parse_model_ids(r#"{"models":[]}"#).is_err());
    }

    #[test]
    fn extracts_openai_error_message() {
        assert_eq!(
            parse_openai_error(r#"{"error":{"message":"invalid key"}}"#).as_deref(),
            Some("invalid key")
        );
    }
}
