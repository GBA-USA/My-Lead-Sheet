/** An @name as typed, compared the way the Directory stores it: no leading @, lowercase. */
export const normalizeHandle = (value: unknown) => (typeof value === "string" ? value.trim().replace(/^@/, "").toLowerCase() : "");

/** The @name a display name suggests: "Sam Rivera" becomes samrivera. Empty when the name has no letters or digits. */
export const handleFromName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
