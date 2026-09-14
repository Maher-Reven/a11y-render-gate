import "@styles/theme.css";

/**
 * expect:
 *   contrast       #8a8a8a on #ffffff, 3.45:1
 *   focus-visible  outline:none with no replacement
 */
export function Button({ label = "Continue" }: { label?: string }) {
  return (
    <button type="button" className="brand-button">
      {label}
    </button>
  );
}

export default Button;
