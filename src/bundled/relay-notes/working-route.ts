import type {
  JsonValue,
  OpenTarget,
  NoteDestination,
} from "../../features/navigation/targets";
import { PUBKEY, UUID } from "../../features/notes/model";
import { notePageRoute } from "../../features/notes/target";
import { notesRoute } from "./routes";

export type DocumentView = Omit<NoteDestination, "id" | "channel">;
export type WorkingRoute = DocumentView & {
  view: "browse" | "note" | "shared" | "profile" | "new";
  id?: string;
  channel?: string;
  draft?: string;
  query?: string;
  trash?: boolean;
  author?: string;
  shared?: string;
  profile?: string;
};
const keys = new Set([
  "view",
  "id",
  "channel",
  "draft",
  "query",
  "trash",
  "edit",
  "dialog",
  "revision",
  "offset",
  "author",
  "shared",
  "profile",
]);

/** Addresses and presentation only. Draft text never enters browser history. */
export function workingRoute(
  value: JsonValue | undefined,
): WorkingRoute | undefined {
  if (value === undefined) return { view: "browse" };
  const shared = notesRoute(value);
  if (shared)
    return {
      view: shared.profile ? "profile" : shared.note ? "shared" : "browse",
      author: shared.author,
      ...(shared.note ? { shared: shared.note } : {}),
      ...(shared.profile ? { profile: shared.profile } : {}),
    };
  const old = notePageRoute(value);
  if (old) return { view: "note", ...old };
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, JsonValue>;
  if (
    Object.keys(row).some((key) => !keys.has(key)) ||
    typeof row.view !== "string" ||
    !["browse", "note", "shared", "profile", "new"].includes(row.view)
  )
    return;
  if (
    (row.author !== undefined &&
      (typeof row.author !== "string" ||
        (row.author !== "" && !PUBKEY.test(row.author)))) ||
    (row.view === "shared"
      ? typeof row.shared !== "string" ||
        !row.shared ||
        !notesRoute({ author: "", note: row.shared })
      : row.shared !== undefined) ||
    (row.view === "profile"
      ? typeof row.profile !== "string" || !PUBKEY.test(row.profile)
      : row.profile !== undefined)
  )
    return;
  if (
    row.view === "note"
      ? typeof row.id !== "string" ||
        !UUID.test(row.id) ||
        typeof row.channel !== "string" ||
        !UUID.test(row.channel)
      : row.id !== undefined || row.channel !== undefined
  )
    return;
  if (
    row.view === "new"
      ? typeof row.draft !== "string" || !UUID.test(row.draft)
      : row.draft !== undefined
  )
    return;
  if (
    row.query !== undefined &&
    (typeof row.query !== "string" || row.query.length > 512)
  )
    return;
  if (
    ["edit", "trash"].some(
      (key) => row[key] !== undefined && typeof row[key] !== "boolean",
    )
  )
    return;
  if (
    row.dialog !== undefined &&
    (row.view !== "note" ||
      typeof row.dialog !== "string" ||
      !["share", "history", "link", "delete"].includes(row.dialog))
  )
    return;
  if (row.edit !== undefined && row.view !== "note") return;
  if (
    row.revision !== undefined &&
    (row.dialog !== "history" ||
      typeof row.revision !== "string" ||
      !PUBKEY.test(row.revision))
  )
    return;
  if (
    row.offset !== undefined &&
    (row.dialog !== "history" ||
      !Number.isInteger(row.offset) ||
      Number(row.offset) < 0 ||
      Number(row.offset) > 10000)
  )
    return;
  return row as WorkingRoute;
}
export function workingTarget(
  target: Extract<OpenTarget, { kind: "page" }>,
  route: WorkingRoute,
): OpenTarget {
  if (!workingRoute({ ...route }))
    throw new Error("Invalid working-note destination.");
  return { ...target, route: { version: 1, params: { ...route } } };
}
