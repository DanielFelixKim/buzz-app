#![cfg(all(target_os = "macos", debug_assertions))]

use buzz_credential_store::{dev_agent_store, read_human, read_session};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

#[test]
fn diagnostic_probe() {
    let Ok(mode) = std::env::var("BUZZ_DIAGNOSTIC_PROBE") else {
        return;
    };
    let result = match mode.as_str() {
        "human" => read_human(),
        "session" => read_session(
            "xyz.block.buzz.desktop.federated-session.debug",
            &"a".repeat(64),
        ),
        "agent" => dev_agent_store(
            "replace",
            "xyz.block.buzz.desktop.agents",
            "agent:private-test-account",
            b"private-test-value",
        )
        .unwrap(),
        _ => panic!("Unknown probe mode"),
    };
    assert_eq!(
        format!("{:?}", result.map(|_| ())),
        std::env::var("BUZZ_DIAGNOSTIC_RESULT").unwrap()
    );
}

#[test]
fn failures_report_only_a_stage_and_an_available_exit_code() {
    let directory = tempfile::tempdir().unwrap();
    let helper = directory.path().join("private-test-helper");
    let cases = [
        ("human", None, "Err(Unavailable)", "spawn", None),
        ("session", None, "Err(Unavailable)", "spawn", None),
        ("human", Some("exit 10"), "Err(Absent)", "exit", Some(10)),
        ("session", Some("exit 11"), "Err(Denied)", "exit", Some(11)),
        ("agent", Some("exit 13"), "Err(Occupied)", "exit", Some(13)),
        ("session", Some("exit 12"), "Err(Corrupt)", "exit", Some(12)),
        (
            "session",
            Some("exit 9"),
            "Err(Unavailable)",
            "exit",
            Some(9),
        ),
        (
            "human",
            Some("kill -TERM $$"),
            "Err(Unavailable)",
            "exit",
            None,
        ),
        (
            "human",
            Some("printf private-test-value"),
            "Err(Corrupt)",
            "reply_size",
            Some(0),
        ),
        (
            "agent",
            Some("/bin/cat <&1 > /dev/null; printf private-test-value"),
            "Err(Corrupt)",
            "reply_size",
            Some(0),
        ),
        (
            "session",
            Some("exec /bin/sleep 60"),
            "Err(Unavailable)",
            "deadline",
            None,
        ),
        (
            "session",
            Some("printf private-test-value"),
            "Ok(())",
            "",
            None,
        ),
    ];
    for (mode, body, result, stage, code) in cases {
        if let Some(body) = body {
            fs::write(
                &helper,
                format!("#!/bin/sh\necho private-test-stderr >&2\n{body}\n"),
            )
            .unwrap();
            fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "diagnostic_probe", "--nocapture"])
            .env("BUZZ_DIAGNOSTIC_PROBE", mode)
            .env("BUZZ_DIAGNOSTIC_RESULT", result)
            .env("BUZZ_DEV_CREDENTIAL_HELPER", &helper)
            .env_remove("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE")
            .output()
            .unwrap();
        assert!(output.status.success(), "{mode} {stage}: {output:?}");
        let expected = if stage.is_empty() {
            String::new()
        } else if let Some(code) = code {
            format!("credential-helper stage={stage} exit_code={code}\n")
        } else {
            format!("credential-helper stage={stage}\n")
        };
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            expected,
            "{mode}"
        );
    }
}
