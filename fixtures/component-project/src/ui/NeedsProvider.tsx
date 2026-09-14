import { createContext, useContext } from "react";

export const LabelContext = createContext<string | null>(null);

/**
 * Throws unless a provider supplies context — the case a component harness
 * cannot infer, and which config.wrapper exists to solve.
 */
export function NeedsProvider() {
  const label = useContext(LabelContext);
  if (!label) throw new Error("LabelContext is missing");
  return <button type="button" className="good-button">{label}</button>;
}

export default NeedsProvider;
