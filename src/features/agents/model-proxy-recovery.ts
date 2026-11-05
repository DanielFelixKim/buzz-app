export type ModelProxyRecovery = Readonly<{
  retry: boolean;
  fallback: boolean;
}>;
const key = (plugin: string) => `buzz.model-proxy.recovery.v1:${plugin}`;
export function modelProxyRecovery(plugin: string): ModelProxyRecovery {
  const saved =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(key(plugin));
  if (saved === null) return { retry: false, fallback: false };
  const value = JSON.parse(saved);
  if (
    !value ||
    typeof value.retry !== "boolean" ||
    typeof value.fallback !== "boolean"
  )
    throw new Error("Model proxy recovery settings could not be read.");
  return value;
}
export function saveModelProxyRecovery(
  plugin: string,
  value: ModelProxyRecovery,
) {
  localStorage.setItem(key(plugin), JSON.stringify(value));
}
