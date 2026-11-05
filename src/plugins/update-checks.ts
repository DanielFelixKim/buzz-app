import type { ImportPreview, PluginImports, PluginInfo } from "./types";

type Authorize = (
  repository: string,
) => Promise<{ repository: string; token: string } | null>;
export type UpdateCheck = {
  installedRevision: string;
  source: string;
  sequence: number;
  checking: boolean;
  revision: string | undefined;
  error: string | null;
};
type Snapshot = Readonly<Record<string, UpdateCheck>>;
const identity = (plugin: PluginInfo) => JSON.stringify(plugin.updateSource);
const installation = (plugin: PluginInfo) =>
  JSON.stringify([plugin.revision, plugin.updateSource]);
export function pluginUpdateCheck(
  snapshot: Snapshot,
  plugin: PluginInfo | undefined,
) {
  if (!plugin) return undefined;
  const result = snapshot[plugin.manifest.id];
  return result?.installedRevision === plugin.revision &&
    result?.source === identity(plugin)
    ? result
    : undefined;
}
export function pluginUpdateAvailable(snapshot: Snapshot, plugin: PluginInfo) {
  const result = pluginUpdateCheck(snapshot, plugin);
  return (
    !!result &&
    !result.error &&
    result.revision !== undefined &&
    result.revision !== plugin.revision
  );
}

/** Read-only source acquisition and its retained results, shared by list and details. */
export function createPluginUpdateChecks(imports: PluginImports | undefined) {
  let snapshot: Snapshot = {};
  let sequence = 0;
  const installations = new Map<string, string>();
  const listeners = new Set<() => void>();
  const pending = new Map<
    string,
    {
      sequence: number;
      revisions: Record<string, string>;
      promise: Promise<string | ImportPreview | null>;
    }
  >();
  const publish = (id: string, result: UpdateCheck) => {
    snapshot = { ...snapshot, [id]: result };
    for (const listener of listeners) listener();
  };
  async function check(
    plugin: PluginInfo,
    authorize?: Authorize,
    force = true,
  ): Promise<void> {
    const source = plugin.updateSource;
    if (!imports || plugin.source !== "external" || !source) return;
    const id = plugin.manifest.id;
    const installed = installation(plugin);
    installations.set(id, installed);
    const current = () => installations.get(id) === installed;
    if (!force && pluginUpdateCheck(snapshot, plugin)) return;
    const key = JSON.stringify(
      "root" in source
        ? ["folder", id, source.root, source.path]
        : ["git", source.repository, source.reference],
    );
    let request = pending.get(key);
    if (
      request &&
      ((request.revisions[id] !== undefined &&
        request.revisions[id] !== plugin.revision) ||
        (snapshot[id]?.sequence ?? 0) > request.sequence)
    ) {
      await request.promise.catch(() => {});
      if (current()) return check(plugin, authorize);
      return;
    }
    if (!request) {
      const promise = (async () => {
        if ("root" in source) return imports.checkFolder(id);
        const signed = await authorize?.(source.repository);
        return imports.checkGit(
          signed?.repository ?? source.repository,
          source.reference,
          signed?.token,
        );
      })().finally(() => pending.delete(key));
      request = { sequence: ++sequence, revisions: {}, promise };
      pending.set(key, request);
    }
    request.revisions[id] = plugin.revision;
    const previous = pluginUpdateCheck(snapshot, plugin);
    const next = {
      installedRevision: plugin.revision,
      source: identity(plugin),
      sequence: request.sequence,
      checking: true,
      revision: previous?.revision,
      error: null,
    };
    if ((snapshot[id]?.sequence ?? 0) > request.sequence) return;
    publish(id, next);
    let revision: string | undefined;
    let error: string | null = null;
    try {
      const result = await request.promise;
      if (typeof result === "string") revision = result;
      else {
        const candidate = result?.candidates.find(
          (item) => item.manifest.id === id && item.path === source.path,
        );
        if (!candidate) {
          const prefix = `${source.path === "." ? "Selected folder" : source.path}:`;
          throw new Error(
            result?.warnings.find((warning) => warning.startsWith(prefix)) ??
              "The saved repository no longer contains this plugin at its installed path.",
          );
        }
        revision = candidate.revision;
      }
    } catch (reason) {
      error = String(reason);
    }
    if (current() && snapshot[id]?.sequence === request.sequence)
      publish(id, { ...next, checking: false, revision, error });
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    observe(plugin: PluginInfo) {
      const started = ++sequence;
      const installed = installation(plugin);
      installations.set(plugin.manifest.id, installed);
      return (revision: string | undefined, error: string | null = null) => {
        if (
          installations.get(plugin.manifest.id) !== installed ||
          (snapshot[plugin.manifest.id]?.sequence ?? 0) > started
        )
          return;
        publish(plugin.manifest.id, {
          installedRevision: plugin.revision,
          source: identity(plugin),
          sequence: started,
          checking: false,
          revision,
          error,
        });
      };
    },
  };
}
export type PluginUpdateChecks = ReturnType<typeof createPluginUpdateChecks>;
