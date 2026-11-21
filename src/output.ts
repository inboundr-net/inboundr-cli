/** Terminal output: colour when it's a terminal, tables, JSON. */

const useColor = (): boolean =>
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));

let colorEnabled: boolean | undefined;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

function paint(code: string, text: string): string {
  if (!(colorEnabled ?? useColor())) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const dim = (s: string) => paint("2", s);
export const bold = (s: string) => paint("1", s);
export const green = (s: string) => paint("32", s);
export const red = (s: string) => paint("31", s);
export const yellow = (s: string) => paint("33", s);
export const cyan = (s: string) => paint("36", s);

export function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/** Notes, progress and errors go to stderr so stdout stays pipeable. */
export function note(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI, "").length;

/*
 * Text from an email — subject, sender, filenames, body, a server's answer —
 * is chosen by whoever sent it. Printed raw, an escape sequence in it runs in
 * the reader's terminal: it can rewrite lines already on screen, set the
 * window title, or, on terminals that allow OSC 52, write to the clipboard.
 * So everything that didn't come from this program goes through safe().
 *
 * Removed: C0 controls (ESC, BEL, a lone CR that returns to the line start,
 * backspace…), DEL, C1 controls (U+0080–U+009F, which include an 8-bit CSI),
 * and the bidirectional overrides that make text display in a different order
 * from the one it's stored in.
 */
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One line of untrusted text: controls removed, whitespace runs collapsed. */
export function safe(value: string | null | undefined): string {
  return (value ?? "").replace(/[\t\n\r]+/g, " ").replace(UNSAFE_LINE, "");
}

/** Untrusted multi-line text, such as an email body: keeps newlines and tabs. */
export function safeBlock(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").replace(UNSAFE_BLOCK, "");
}

/** Cuts to `max` characters, ending in "…" when it had to cut. Also safe(). */
export function truncate(value: string, max: number): string {
  const s = safe(value).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export type Column<T> = {
  header: string;
  value: (row: T) => string;
  /** Longest a cell may be before it's cut. */
  max?: number;
};

export function table<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;
  const cells = rows.map((row) =>
    columns.map((c) => (c.max ? truncate(c.value(row), c.max) : c.value(row))),
  );
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((r) => visibleLength(r[i] ?? ""))),
  );
  const line = (values: string[]) =>
    values
      .map((v, i) =>
        i === values.length - 1 ? v : v + " ".repeat((widths[i] ?? 0) - visibleLength(v)),
      )
      .join("  ")
      .trimEnd();
  print(dim(line(columns.map((c) => c.header))));
  for (const r of cells) print(line(r));
}

/** "2026-11-21 14:02" in local time; "—" for nothing. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatList(values: string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "—";
}
