import type { ReactNode } from "react";
import { LabelContext } from "@ui/NeedsProvider";

/** Providers are declared here, never guessed at by the harness. */
export default function Wrapper({ children }: { children: ReactNode }) {
  return <LabelContext.Provider value="Wrapped">{children}</LabelContext.Provider>;
}
