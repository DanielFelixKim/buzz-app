//! The main webview renders at the display's refresh rate, on macOS.
//!
//! On a display faster than 60 Hz, WebKit holds page rendering updates
//! (`requestAnimationFrame`, style, layout and main-thread paint) near 60 fps
//! while its "Prefer Page Rendering Updates near 60fps" feature is on, as it
//! is by default. A 120 Hz display then gets one rendering update every other
//! refresh. Only private `WKPreferences` API turns the feature off: the
//! `+_features` list and `-_setEnabled:forFeature:`, which Safari's Feature
//! Flags menu uses. A WebKit without either, or without the feature, keeps
//! the cap.
//!
//! A page applies the change when its rendering cadence is next recomputed,
//! as when its window is shown, not when the feature is set. Wry starts
//! loading before Tauri's setup runs, but the macOS launch window stays
//! hidden until the page shows it.

use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol},
    sel, ClassType,
};
use objc2_foundation::{NSArray, NSString};
use objc2_web_kit::{WKPreferences, WKWebView};

const NEAR_60_FPS: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// Turns the cap off for `webview`. Call on the main thread, before the main
/// window is first shown.
pub(crate) fn install(webview: &tauri::webview::PlatformWebview) {
    // SAFETY: Wry's macOS webview is a WKWebView.
    let webview = unsafe { &*webview.inner().cast::<WKWebView>() };
    let preferences = unsafe { webview.configuration().preferences() };
    if !WKPreferences::class()
        .metaclass()
        .responds_to(sel!(_features))
        || !preferences.respondsToSelector(sel!(_setEnabled:forFeature:))
    {
        eprintln!("WebKit cannot change its rendering rate");
        return;
    }
    let features: Retained<NSArray<AnyObject>> =
        unsafe { msg_send![WKPreferences::class(), _features] };
    let key = NSString::from_str(NEAR_60_FPS);
    let feature = features.iter().find(|feature| {
        feature.class().responds_to(sel!(key)) && {
            let name: Retained<NSString> = unsafe { msg_send![feature, key] };
            name == key
        }
    });
    match feature {
        Some(feature) => unsafe {
            let _: () = msg_send![&preferences, _setEnabled: false, forFeature: &*feature];
        },
        None => eprintln!("WebKit has no {NEAR_60_FPS} feature"),
    }
}
