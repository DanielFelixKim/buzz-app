//! Native cache admission, scoped by the secure session's unique revision.
//! A new login never inherits proof, even when it uses the same organization account.
use super::{config::canonical_relay, protocol::now, FederatedIdentity, Status};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Admission {
    pub(crate) viewer: String,
    pub(crate) relay: String,
    pub(crate) allowed: bool,
}

/// A refusal wins over late or concurrent success for this session revision.
pub(super) fn record(entries: &mut Vec<Admission>, next: Admission) -> Result<(), &'static str> {
    if let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry.viewer == next.viewer && entry.relay == next.relay)
    {
        entry.allowed &= next.allowed;
    } else {
        if entries.len() >= 128 {
            return Err("storage-unavailable");
        }
        entries.push(next);
    }
    Ok(())
}

impl FederatedIdentity {
    pub(super) async fn cache_result(
        &self,
        revision: &str,
        viewer: &str,
        relay: &str,
        allowed: bool,
    ) -> Result<(), String> {
        // Socket cancellation can follow the immediate denial notification. The
        // durable write (or session retirement on failure) must still finish.
        let owner = self.server_for(&canonical_relay(relay)?)?;
        let revision = revision.to_owned();
        let viewer = viewer.to_owned();
        let relay = relay.to_owned();
        tokio::spawn(async move {
            owner
                .persist_cache_result(&revision, &viewer, &relay, allowed)
                .await
        })
        .await
        .map_err(|_| "storage-unavailable".to_owned())?
    }

    async fn persist_cache_result(
        &self,
        revision: &str,
        viewer: &str,
        relay: &str,
        allowed: bool,
    ) -> Result<(), String> {
        let relay = canonical_relay(relay)?;
        if !self.protects(&relay) {
            return Ok(());
        }
        let _operation = self.0.cache_operation.lock().await;
        let admission = Admission {
            viewer: viewer.into(),
            relay,
            allowed,
        };
        let session = {
            let mut state = self.state();
            let session = state
                .session
                .clone()
                .filter(|session| {
                    !state.closed
                        && state.snapshot.status == Status::SignedIn
                        && state.snapshot.revision == revision
                        && session.record.revision == revision
                })
                .ok_or("Federated session changed")?;
            if super::protocol::expiry(&session.record.expires_at).map_err(str::to_owned)?
                <= now().map_err(str::to_owned)?
            {
                return Err("Federated session expired".into());
            }
            if !allowed {
                record(&mut state.snapshot.cache_admissions, admission.clone())
                    .map_err(str::to_owned)?;
                state.cache_epoch += 1;
                self.publish(&state);
            }
            session
        };
        let saved_revision = revision.to_owned();
        let result = self
            .storage(move |store| store.record_cache_admission(&saved_revision, admission))
            .await;
        let entries = match result {
            Ok(entries) => entries,
            Err(failure) => {
                // A refusal which cannot be saved must not leave reusable offline proof.
                if !allowed {
                    let retired_revision = {
                        let mut state = self.state();
                        if state.snapshot.revision != revision {
                            return Err("Federated session changed".into());
                        }
                        self.retire_state(&mut state, Status::Unavailable, Some(failure.code));
                        state.snapshot.revision.clone()
                    };
                    self.remove_retired(session, &retired_revision).await;
                }
                return Err(failure.code.into());
            }
        };
        let mut state = self.state();
        if state.closed
            || state.snapshot.revision != revision
            || state.snapshot.status != Status::SignedIn
        {
            return Err("Federated session changed".into());
        }
        state.snapshot.cache_admissions = entries;
        state.cache_epoch += 1;
        self.publish(&state);
        Ok(())
    }
}
