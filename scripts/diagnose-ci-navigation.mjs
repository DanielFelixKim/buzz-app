import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

// Temporary incident instrumentation. Applied only in the diagnostic runner.
function replace(path, before, after) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.includes(before), `Missing diagnostic seam: ${path}`);
  writeFileSync(path, source.replace(before, after));
}

const timeline = "src/features/messages/ChannelTimeline.tsx";
replace(
  timeline,
  "    const prior = presentedVisit.current;",
  `    const prior = presentedVisit.current;
    console.info("CI_NAV", JSON.stringify({ phase: "return", entry: navigation.entryId, target: navigation.target, returning, prior: prior?.entryId, sameSignal: prior?.signal === navigation.signal, stored: navigation.position(TIMELINE_PLACE), saved: savedPosition.current, intent: intent.current, settled: settled.current }));`,
);
replace(
  timeline,
  "    const place = navigation.position(TIMELINE_PLACE) as ReadingPosition;",
  `    const place = navigation.position(TIMELINE_PLACE) as ReadingPosition;
    console.info("CI_NAV", JSON.stringify({ phase: "restore", entry: navigation.entryId, place }));`,
);
replace(
  timeline,
  "        navigation.savePosition(TIMELINE_PLACE, savedPosition.current);",
  `        { console.info("CI_NAV", JSON.stringify({ phase: "save", entry: navigation.entryId, saved: savedPosition.current })); navigation.savePosition(TIMELINE_PLACE, savedPosition.current); }`,
);
replace(
  timeline,
  "    const restorePosition = () => {",
  `    const restorePosition = () => {
      console.info("CI_NAV", JSON.stringify({ phase: "position", entry: navigation?.entryId, scheduledIntent, intent: intent.current, follow: follow.current, anchor, restoreIndex, offset: scroller.current?.scrollTop }));`,
);
replace(
  timeline,
  "      if (restore && !follow.current && intent.current === scheduledIntent) {",
  `      if (restore && !follow.current && intent.current === scheduledIntent) {
        console.info("CI_NAV", JSON.stringify({ phase: "position-cleanup", entry: navigation?.entryId, scheduledIntent, saved: savedPosition.current, restore }));`,
);
replace(
  "tests/browser/navigation-channel-history.spec.mjs",
  "  const [first, second] = [3, 8].map((n) => alphaMessage(app, n));",
  `  page.on("console", (message) => {
    if (message.text().startsWith("CI_NAV")) console.log(message.text());
  });
  const [first, second] = [3, 8].map((n) => alphaMessage(app, n));
  console.log("CI_NAV targets", JSON.stringify({ first: first.id, second: second.id }));`,
);
