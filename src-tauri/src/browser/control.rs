//! Opt-in control of a website guest, never of Buzz's trusted main document.
use super::*;
use serde_json::{json, value::RawValue, Value};

const CALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
const TOKEN_LENGTH: usize = 36;
const TEXT_BYTES: usize = 8192;
const REF_REVISION_DIGITS: usize = 10;
const REF_INDEX_DIGITS: usize = 6;
/// Every reply, including a `stale_ref` message, fits in 128 KiB.
const REPLY_BYTES: usize = 131_072;
/// `control.js` keeps its part of a Snapshot to 120 KiB, which leaves room
/// for the fields native code adds.
const PAGE_PART_BYTES: usize = 122_880;
const ELEMENT_LIMIT: usize = 150;
const NAME_CHARS: usize = 200;
const TEXT_CHARS: usize = 20_000;
const TITLE_CHARS: usize = 200;
const URL_BYTES: usize = 2048;
const HREF_BYTES: usize = 2048;
const ROLE_BYTES: usize = 32;

/// The codes every agent-facing failure starts with.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Code {
    InvalidRequest,
    InvalidUrl,
    Unavailable,
    NotVisible,
    Revoked,
    Busy,
    StaleRef,
    NotInteractable,
    UnsupportedInput,
    Timeout,
}

impl Code {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidUrl => "invalid_url",
            Self::Unavailable => "unavailable",
            Self::NotVisible => "not_visible",
            Self::Revoked => "revoked",
            Self::Busy => "busy",
            Self::StaleRef => "stale_ref",
            Self::NotInteractable => "not_interactable",
            Self::UnsupportedInput => "unsupported_input",
            Self::Timeout => "timeout",
        }
    }

    /// `control.js` runs in the page's JavaScript world, so a page could
    /// otherwise claim a host-only code such as `revoked`.
    fn page_may_send(self) -> bool {
        matches!(
            self,
            Self::StaleRef | Self::NotInteractable | Self::UnsupportedInput | Self::InvalidRequest
        )
    }
}

fn failure(code: Code, sentence: impl std::fmt::Display) -> String {
    format!("{}: {sentence}", code.as_str())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Page,
    Viewport,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Observe {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<Scope>,
    },
    Click {
        #[serde(rename = "ref")]
        reference: String,
    },
    Fill {
        #[serde(rename = "ref")]
        reference: String,
        text: String,
    },
    Navigate {
        url: String,
    },
}

impl Request {
    fn reference(&self) -> Option<&str> {
        match self {
            Self::Click { reference } | Self::Fill { reference, .. } => Some(reference),
            Self::Observe { .. } | Self::Navigate { .. } => None,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if let Some(reference) = self.reference() {
            if ref_revision(reference).is_none() {
                return Err(failure(
                    Code::InvalidRequest,
                    "ref must look like r4e12, copied from a Snapshot.",
                ));
            }
        }
        if let Self::Fill { text, .. } = self {
            if text.len() > TEXT_BYTES {
                return Err(failure(
                    Code::InvalidRequest,
                    format!("text must be at most {TEXT_BYTES} bytes."),
                ));
            }
        }
        Ok(())
    }
}

/// The revision a ref names, when it matches `r<revision>e<index>` with up to
/// ten revision digits, up to six index digits, and no leading zeros.
fn ref_revision(reference: &str) -> Option<u64> {
    let (revision, index) = reference.strip_prefix('r')?.split_once('e')?;
    let number = |part: &str, most: usize| {
        !part.is_empty()
            && part.len() <= most
            && !part.starts_with('0')
            && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !number(revision, REF_REVISION_DIGITS) || !number(index, REF_INDEX_DIGITS) {
        return None;
    }
    revision.parse().ok()
}

fn permitted<T>(
    token: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String>,
) -> Result<T, String> {
    BROWSERS.with(|browsers| {
        let browsers = browsers.borrow();
        let browser = browsers
            .iter()
            .find(|browser| browser.control.borrow().as_deref() == Some(token))
            .ok_or_else(|| {
                failure(
                    Code::NotVisible,
                    "The page is no longer shared, because it was closed, replaced, or its access was revoked.",
                )
            })?;
        if !browser.visible.get() {
            return Err(failure(
                Code::NotVisible,
                "The page is hidden, so the person must show it again.",
            ));
        }
        operation(browser)
    })
}

/// Runs `operation` on the UI thread when `token` still controls a visible guest.
async fn hop<T: Send + 'static>(
    app: &AppHandle,
    token: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let token = token.to_owned();
    on_main_thread(app, move || Ok(permitted(&token, operation)))
        .await
        .map_err(|error| failure(Code::Unavailable, error))?
}

#[derive(Serialize)]
pub struct Grant {
    pub token: String,
    pub revision: u64,
}

#[tauri::command]
pub async fn browser_control_grant(app: AppHandle, session_id: String) -> Result<Grant, String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            if !browser.visible.get() {
                return Err("Show the browser before allowing control".into());
            }
            let token = uuid::Uuid::new_v4().to_string();
            *browser.control.borrow_mut() = Some(token.clone());
            let revision = browser.control_revision.get() + 1;
            browser.control_revision.set(revision);
            Ok(Grant { token, revision })
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_control_revoke(app: AppHandle, session_id: String) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            browser.revoke_control();
            Ok(())
        })
    })
    .await
}

/// Takes the request as JSON so a malformed request fails with
/// `invalid_request` like every other agent-facing failure.
#[tauri::command]
pub async fn browser_control_execute(
    app: AppHandle,
    token: String,
    request: Value,
) -> Result<Box<RawValue>, String> {
    let request: Request = serde_json::from_value(request)
        .map_err(|error| failure(Code::InvalidRequest, format!("{error}.")))?;
    request.validate()?;
    if token.len() != TOKEN_LENGTH {
        return Err(failure(
            Code::NotVisible,
            "The page is no longer shared with you.",
        ));
    }
    let reply = tokio::time::timeout(CALL_DEADLINE, run(&app, &token, request))
        .await
        .map_err(|_| {
            failure(
                Code::Timeout,
                "The page did not finish within 5 s, and the action may have run, so observe before you retry.",
            )
        })??;
    RawValue::from_string(reply).map_err(|error| failure(Code::Unavailable, error))
}

enum Failure {
    StaleRef,
    Coded(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Coded(message)
    }
}

async fn run(app: &AppHandle, token: &str, request: Request) -> Result<String, String> {
    match perform(app, token, &request).await {
        Ok(reply) => Ok(reply),
        Err(Failure::Coded(message)) => Err(message),
        Err(Failure::StaleRef) => Err(stale_ref_message(&snapshot(app, token, None).await?)?),
    }
}

async fn perform(app: &AppHandle, token: &str, request: &Request) -> Result<String, Failure> {
    match request {
        Request::Observe { scope } => Ok(snapshot(app, token, *scope).await?),
        Request::Navigate { url } => {
            let url = url.clone();
            hop(app, token, move |browser| {
                browser
                    .navigate(&url, false)
                    .map_err(|error| failure(Code::InvalidUrl, error))
            })
            .await?;
            Ok(json!({"navigating": true}).to_string())
        }
        Request::Click { .. } | Request::Fill { .. } => {
            act(app, token, request).await?;
            Ok(snapshot(app, token, None).await?)
        }
    }
}

/// Runs one action script. Native code rejects a ref from an older revision
/// before the page sees it.
async fn act(app: &AppHandle, token: &str, request: &Request) -> Result<(), Failure> {
    let revision = hop(app, token, |browser| Ok(browser.document_revision())).await?;
    if request
        .reference()
        .is_some_and(|reference| ref_revision(reference) != Some(revision))
    {
        return Err(Failure::StaleRef);
    }
    let reply = evaluate(
        app.clone(),
        token.to_owned(),
        json!({"revision": revision, "request": request}),
    )
    .await?;
    action_outcome(&reply)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageError {
    error: PageErrorDetail,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageErrorDetail {
    code: Code,
    message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Done {
    ok: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ActionReply {
    Done(Done),
    Error(PageError),
}

fn action_outcome(reply: &str) -> Result<(), Failure> {
    match serde_json::from_str(reply) {
        Ok(ActionReply::Done(Done { ok: true })) => Ok(()),
        Ok(ActionReply::Error(PageError { error })) if error.code == Code::StaleRef => {
            Err(Failure::StaleRef)
        }
        Ok(ActionReply::Error(PageError { error })) if error.code.page_may_send() => {
            Err(Failure::Coded(failure(error.code, error.message)))
        }
        _ => Err(Failure::Coded(failure(
            Code::Unavailable,
            "The page sent a malformed reply.",
        ))),
    }
}

struct NativeFields {
    url: String,
    title: String,
    revision: u64,
    loading: bool,
}

/// Reads the fields a hostile page cannot forge, in the hop that starts the
/// extraction script, so they and the refs describe one document.
fn native_fields(browser: &BrowserSession) -> Result<NativeFields, String> {
    let status = browser
        .snapshot()
        .map_err(|error| failure(Code::Unavailable, error))?;
    Ok(NativeFields {
        url: status.url,
        title: status.title,
        revision: browser.document_revision(),
        loading: status.loading,
    })
}

async fn snapshot(app: &AppHandle, token: &str, scope: Option<Scope>) -> Result<String, String> {
    let request = Request::Observe { scope };
    let (native, reply) = hop(app, token, move |browser| {
        let native = native_fields(browser)?;
        let reply = start_script(
            browser,
            &json!({"revision": native.revision, "request": request}),
        )?;
        Ok((native, reply))
    })
    .await?;
    let reply = receive(reply).await?;
    let final_revision = hop(app, token, |browser| Ok(browser.document_revision())).await?;
    assemble_snapshot(&reply, &native, final_revision)
}

type Reply = tokio::sync::oneshot::Receiver<Result<String, String>>;

fn start_script(browser: &BrowserSession, input: &Value) -> Result<Reply, String> {
    let script = format!(
        "(() => {{ const operate = {}; return operate({input}); }})()",
        include_str!("control.js"),
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(sender));
    browser
        .guest
        .evaluate_script_with_callback(&script, move |reply| {
            let reply = if reply.len() > REPLY_BYTES {
                Err(failure(
                    Code::Unavailable,
                    "The page sent a reply larger than 128 KiB.",
                ))
            } else {
                Ok(reply)
            };
            if let Some(sender) = sender.lock().expect("Browser callback lock").take() {
                let _ = sender.send(reply);
            }
        })
        .map_err(|error| failure(Code::Unavailable, error))?;
    Ok(receiver)
}

async fn receive(reply: Reply) -> Result<String, String> {
    reply
        .await
        .map_err(|_| failure(Code::NotVisible, "The page closed before it replied."))?
}

/// Sends one `control.js` evaluation to the guest that `token` controls and
/// returns its raw reply.
pub(crate) async fn evaluate(
    app: AppHandle,
    token: String,
    input: Value,
) -> Result<String, String> {
    let reply = hop(&app, &token, move |browser| start_script(browser, &input)).await?;
    receive(reply).await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PagePart {
    text: String,
    elements: Vec<Element>,
    truncated: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Element {
    #[serde(rename = "ref")]
    reference: String,
    role: String,
    name: String,
    in_viewport: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    href: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled: Option<bool>,
}

impl Element {
    fn follows_the_rules(&self, revision: u64) -> bool {
        ref_revision(&self.reference) == Some(revision)
            && role_allowed(&self.role)
            && self.name.chars().count() <= NAME_CHARS
            && self.href.as_deref().is_none_or(|href| {
                href.len() <= HREF_BYTES
                    && (href.starts_with("http://") || href.starts_with("https://"))
            })
    }
}

fn role_allowed(role: &str) -> bool {
    (1..=ROLE_BYTES).contains(&role.len())
        && role.bytes().all(|byte| byte.is_ascii_lowercase())
        && !matches!(role, "presentation" | "none" | "generic")
}

#[derive(Serialize)]
struct Snapshot<'a> {
    url: &'a str,
    title: &'a str,
    revision: u64,
    loading: bool,
    text: &'a str,
    elements: &'a [Element],
    truncated: bool,
}

/// Builds the Snapshot JSON from the page's reply and the native fields.
/// Only a forged reply breaks a page rule, so a violation fails the call
/// rather than being repaired.
fn assemble_snapshot(
    reply: &str,
    native: &NativeFields,
    final_revision: u64,
) -> Result<String, String> {
    let malformed = || failure(Code::Unavailable, "The page sent a malformed Snapshot.");
    let page: PagePart = serde_json::from_str(reply).map_err(|_| malformed())?;
    if page.elements.len() > ELEMENT_LIMIT
        || page.text.chars().count() > TEXT_CHARS
        || !page
            .elements
            .iter()
            .all(|element| element.follows_the_rules(native.revision))
        || serde_json::to_vec(&page).map_err(|_| malformed())?.len() > PAGE_PART_BYTES
    {
        return Err(malformed());
    }
    let (title, title_cut) = cut_chars(&native.title, TITLE_CHARS);
    let (url, url_cut) = cut_bytes(&native.url, URL_BYTES);
    let snapshot = serde_json::to_string(&Snapshot {
        url,
        title,
        revision: native.revision,
        loading: native.loading || final_revision != native.revision,
        text: &page.text,
        elements: &page.elements,
        truncated: page.truncated || title_cut || url_cut,
    })
    .map_err(|_| malformed())?;
    if snapshot.len() > REPLY_BYTES {
        return Err(failure(
            Code::Unavailable,
            "The Snapshot is larger than 128 KiB.",
        ));
    }
    Ok(snapshot)
}

fn cut_chars(value: &str, most: usize) -> (&str, bool) {
    match value.char_indices().nth(most) {
        Some((end, _)) => (&value[..end], true),
        None => (value, false),
    }
}

fn cut_bytes(value: &str, most: usize) -> (&str, bool) {
    if value.len() <= most {
        return (value, false);
    }
    let end = (0..=most)
        .rev()
        .find(|&end| value.is_char_boundary(end))
        .unwrap_or(0);
    (&value[..end], true)
}

fn stale_ref_message(snapshot: &str) -> Result<String, String> {
    let message = format!(
        "{}\n{snapshot}",
        failure(
            Code::StaleRef,
            "The page changed after that ref was issued. Use refs from this Snapshot."
        )
    );
    if message.len() > REPLY_BYTES {
        return Err(failure(
            Code::Unavailable,
            "The stale_ref reply is larger than 128 KiB.",
        ));
    }
    Ok(message)
}

pub fn handle(request: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        browser_control_grant,
        browser_control_revoke,
        browser_control_execute
    ];
    handler(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The parse and validation that `browser_control_execute` applies to a raw request.
    fn checked(request: &str) -> Result<Request, String> {
        let request: Request = serde_json::from_str(request).map_err(|error| error.to_string())?;
        request.validate().map_err(|error| error.to_string())?;
        Ok(request)
    }

    /// Each row is (name, raw request, Ok or Err with a fragment the error must contain).
    fn validation_mismatches(rows: Vec<(&str, String, Result<(), &str>)>) -> Vec<String> {
        rows.into_iter()
            .filter_map(|(name, request, expected)| {
                let outcome = checked(&request);
                let matched = match (&outcome, expected) {
                    (Ok(_), Ok(())) => true,
                    (Err(error), Err(fragment)) => error.contains(fragment),
                    _ => false,
                };
                (!matched).then(|| format!("{name}: expected {expected:?}, got {outcome:?}"))
            })
            .collect()
    }

    fn page(revision: u64) -> NativeFields {
        NativeFields {
            url: "https://example.com/".into(),
            title: "Example".into(),
            revision,
            loading: false,
        }
    }

    #[test]
    fn native_validation_accepts_refs_and_text_up_to_their_limits_and_rejects_selector() {
        let text_at_limit = "é".repeat(4096);
        let text_over_limit = format!("{text_at_limit}x");
        let mismatches = validation_mismatches(vec![
            (
                "highest ref index",
                r#"{"action":"click","ref":"r1e999999"}"#.into(),
                Ok(()),
            ),
            (
                "ref index past the pattern",
                r#"{"action":"click","ref":"r1e1000000"}"#.into(),
                Err(""),
            ),
            (
                "8192 bytes of text",
                json!({"action": "fill", "ref": "r1e1", "text": text_at_limit}).to_string(),
                Ok(()),
            ),
            (
                "8193 bytes of text",
                json!({"action": "fill", "ref": "r1e1", "text": text_over_limit}).to_string(),
                Err(""),
            ),
            (
                "selector field",
                r##"{"action":"click","selector":"#name"}"##.into(),
                Err("selector"),
            ),
        ]);
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[test]
    fn largest_honest_page_part_with_capped_title_and_url_fits_a_stale_ref_message() {
        let control_name = "\u{1}".repeat(200);
        let reply = json!({
            "text": format!("{}{}", "\u{1}".repeat(19_813), "\\".repeat(95)),
            "elements": [
                {"ref": "r7e1", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e2", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e3", "role": "link", "name": control_name, "inViewport": true},
            ],
            "truncated": true,
        })
        .to_string();
        assert_eq!(
            reply.len(),
            122_880,
            "precondition: page part at the 120 KiB cap"
        );
        let native = NativeFields {
            url: "\\".repeat(2048),
            title: "\u{1}".repeat(200),
            revision: 7,
            loading: false,
        };

        let snapshot = assemble_snapshot(&reply, &native, 7).expect("an honest page assembles");
        let message = stale_ref_message(&snapshot).expect("the stale_ref message fits");

        assert!(
            message.starts_with(
                "stale_ref: The page changed after that ref was issued. Use refs from this Snapshot.\n"
            ),
            "{}",
            message.chars().take(120).collect::<String>()
        );
        assert!(
            message.len() < 131_072,
            "message is {} bytes",
            message.len()
        );
    }

    #[test]
    fn page_part_one_byte_over_120_kib_is_unavailable() {
        let control_name = "\u{1}".repeat(200);
        let reply = json!({
            "text": format!("{}{}a", "\u{1}".repeat(19_813), "\\".repeat(95)),
            "elements": [
                {"ref": "r7e1", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e2", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e3", "role": "link", "name": control_name, "inViewport": true},
            ],
            "truncated": true,
        })
        .to_string();
        assert_eq!(
            reply.len(),
            122_881,
            "precondition: page part one byte over the cap"
        );

        let error = assemble_snapshot(&reply, &page(7), 7).expect_err("oversized page part");

        assert!(error.starts_with("unavailable: "), "{error}");
    }

    #[test]
    fn native_cuts_a_1_mib_title_and_url_and_marks_the_snapshot_truncated() {
        let reply = r#"{"text":"","elements":[],"truncated":false}"#;
        let native = NativeFields {
            url: format!("https://example.com/x{}", "é".repeat(524_288)),
            title: "é".repeat(524_288),
            revision: 7,
            loading: false,
        };

        let snapshot: Value =
            serde_json::from_str(&assemble_snapshot(reply, &native, 7).expect("assembles"))
                .expect("the Snapshot is JSON");

        assert_eq!(snapshot["title"], "é".repeat(200));
        assert_eq!(
            snapshot["url"],
            format!("https://example.com/x{}", "é".repeat(1013))
        );
        assert_eq!(snapshot["truncated"], true);
    }

    #[test]
    fn page_part_with_151_elements_is_unavailable() {
        let elements: Vec<Value> = (1..=151)
            .map(|index| {
                json!({"ref": format!("r7e{index}"), "role": "link", "name": "Link", "inViewport": true})
            })
            .collect();
        let reply = json!({"text": "", "elements": elements, "truncated": true}).to_string();

        let error = assemble_snapshot(&reply, &page(7), 7).expect_err("151 elements");

        assert!(error.starts_with("unavailable: "), "{error}");
    }

    #[test]
    fn page_part_with_a_ref_from_another_revision_is_unavailable() {
        let reply = r#"{"text":"","elements":[{"ref":"r6e1","role":"link","name":"Old","inViewport":true}],"truncated":false}"#;

        let error = assemble_snapshot(reply, &page(7), 7).expect_err("ref from revision 6");

        assert!(error.starts_with("unavailable: "), "{error}");
    }

    #[test]
    fn page_part_with_escapes_and_every_optional_field_reserializes_to_the_same_bytes() {
        let page_fields = r#""text":"東京 \u0001 \"quoted\" back\\slash","elements":[{"ref":"r7e1","role":"link","name":"地図 \"map\"","inViewport":true,"href":"https://example.com/map?q=1"},{"ref":"r7e2","role":"checkbox","name":"同意","inViewport":false,"checked":true,"disabled":true}],"truncated":false"#;
        let reply = format!("{{{page_fields}}}");

        let snapshot = assemble_snapshot(&reply, &page(7), 7).expect("assembles");

        assert!(snapshot.contains(page_fields), "{snapshot}");
    }

    #[test]
    fn page_part_of_150_elements_without_optional_fields_gains_no_null() {
        let elements = (1..=150)
            .map(|index| {
                format!(r#"{{"ref":"r7e{index}","role":"button","name":"Button {index}","inViewport":true}}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        let page_fields = format!(r#""text":"Buttons","elements":[{elements}],"truncated":false"#);
        let reply = format!("{{{page_fields}}}");

        let snapshot = assemble_snapshot(&reply, &page(7), 7).expect("assembles");

        assert!(snapshot.contains(&page_fields), "page part changed");
        assert!(
            !snapshot.contains("null"),
            "absent fields were written as null"
        );
    }

    #[test]
    fn new_document_during_extraction_keeps_the_earlier_fields_and_reports_loading() {
        let reply = r#"{"text":"Old page","elements":[{"ref":"r7e1","role":"link","name":"Next","inViewport":true}],"truncated":false}"#;
        let native = NativeFields {
            url: "https://example.com/old".into(),
            title: "Old".into(),
            revision: 7,
            loading: false,
        };

        let snapshot: Value =
            serde_json::from_str(&assemble_snapshot(reply, &native, 8).expect("assembles"))
                .expect("the Snapshot is JSON");

        assert_eq!(snapshot["revision"], 7);
        assert_eq!(snapshot["url"], "https://example.com/old");
        assert_eq!(snapshot["title"], "Old");
        assert_eq!(snapshot["loading"], true);
    }
}
