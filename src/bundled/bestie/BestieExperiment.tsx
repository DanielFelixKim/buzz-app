import { createContext, useContext, useState, type ReactNode } from "react";
import { Select } from "../../shared/design-system/ui/Select";

export type BestieTake = "current" | "top-nav" | "floating";
const Experiment = createContext({
  take: "current" as BestieTake,
  setTake: (_take: BestieTake) => {},
});
const key = "buzz.dev.bestie-take";
function initialTake(): BestieTake {
  if (!import.meta.env.DEV) return "current";
  try {
    const saved = sessionStorage.getItem(key);
    if (saved === "current" || saved === "floating") return saved;
  } catch {
    /* Storage is optional for this development-only choice. */
  }
  return "top-nav";
}

/** A presentation experiment, never an agent or account preference. */
export function BestieExperiment({ children }: { children: ReactNode }) {
  const [take, update] = useState(initialTake);
  return (
    <Experiment
      value={{
        take,
        setTake: (next) => {
          update(next);
          try {
            sessionStorage.setItem(key, next);
          } catch {
            /* Optional. */
          }
        },
      }}
    >
      {children}
    </Experiment>
  );
}
export const useBestieTake = () => useContext(Experiment).take;
export function BestieTakePicker() {
  const { take, setTake } = useContext(Experiment);
  if (!import.meta.env.DEV) return null;
  return (
    <Select
      label="Bestie prototype"
      variant="compact"
      size="xs"
      value={take}
      onValueChange={(value) => {
        if (value === "current" || value === "top-nav" || value === "floating")
          setTake(value);
      }}
      groups={[
        {
          label: "Bestie prototype",
          options: [
            { value: "current", label: "Current panel" },
            { value: "top-nav", label: "Top nav" },
            { value: "floating", label: "Floating avatar" },
          ],
        },
      ]}
    />
  );
}
