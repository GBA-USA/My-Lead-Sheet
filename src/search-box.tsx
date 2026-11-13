import "./search.css";

export function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      className="search-box"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
