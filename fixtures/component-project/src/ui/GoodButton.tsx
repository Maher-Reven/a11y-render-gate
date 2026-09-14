import "@styles/theme.css";

/** expect: nothing. */
export function GoodButton({ label = "Continue" }: { label?: string }) {
  return (
    <button type="button" className="good-button">
      {label}
    </button>
  );
}

export default GoodButton;
