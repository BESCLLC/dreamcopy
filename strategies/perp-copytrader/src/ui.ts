// The terminal is this bot's only interface, so it gets treated like one.
//
// Everything here is presentation: a small truecolor palette, ANSI-aware
// padding (a coloured cell is wider in bytes than it looks on screen, which is
// what makes naive tables fray), and a rounded box renderer. Nothing in this
// file reads state or talks to the network, so a strategy can be read without
// it and it can be restyled without touching the strategy.

const TTY = Boolean(process.stdout.isTTY);
/** Honour NO_COLOR, and fall back to plain text when piped to a file. */
const COLOR = TTY && !process.env.NO_COLOR;

const sgr = (open: string) => (s: string) => (COLOR ? `\u001b[${open}m${s}\u001b[0m` : s);
/** 24-bit foreground. Terminals that predate truecolor degrade to the nearest colour themselves. */
const rgb = (r: number, g: number, b: number) => sgr(`38;2;${r};${g};${b}`);

/**
 * One palette, used everywhere.
 *
 * `mint`/`rose` carry direction (long/short, profit/loss) and are the only two
 * colours allowed to mean something, so a glance at a screen full of numbers
 * still reads. The greys carry structure.
 */
export const c = {
  mint: rgb(94, 234, 212),
  rose: rgb(251, 113, 133),
  amber: rgb(251, 191, 36),
  violet: rgb(167, 139, 250),
  sky: rgb(56, 189, 248),
  text: rgb(228, 228, 231),
  dim: rgb(113, 113, 122),
  faint: rgb(63, 63, 70),
  bold: sgr("1"),
  under: sgr("4"),
};

const ANSI = /\u001b\[[0-9;]*m/g;
/** On-screen width of a possibly-coloured string. */
export const width = (s: string): number => s.replace(ANSI, "").length;

/** Pad to `n` columns, measuring what the eye sees rather than what the string holds. */
export function pad(s: string, n: number, align: "left" | "right" = "left"): string {
  const gap = Math.max(0, n - width(s));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

/** Clip to `n` columns with an ellipsis. Only ever used on uncoloured text. */
export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

/**
 * A rounded box table.
 *
 * Column widths come from the widest *rendered* cell, so colour never shifts a
 * border. Cells arrive already coloured; this function only measures and places.
 */
export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(width(col.header), ...rows.map((r) => width(r[i] ?? ""))),
  );
  const line = (l: string, mid: string, r: string) =>
    c.faint(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r);
  const row = (cells: string[], bold = false) =>
    c.faint("│") +
    cells
      .map((cell, i) => ` ${pad(bold ? c.bold(cell) : cell, widths[i] ?? 0, columns[i]?.align)} `)
      .join(c.faint("│")) +
    c.faint("│");

  return [
    line("╭", "┬", "╮"),
    row(columns.map((col) => c.dim(col.header))),
    line("├", "┼", "┤"),
    ...rows.map((r) => row(r)),
    line("╰", "┴", "╯"),
  ].join("\n");
}

/** A labelled section heading, used to break the run into readable phases. */
export function heading(text: string): string {
  return `\n${c.violet("▍")} ${c.bold(c.text(text))}`;
}

/** `key  value` aligned under a heading. */
export function field(key: string, value: string, keyWidth = 16): string {
  return `  ${c.dim(pad(key, keyWidth))} ${value}`;
}

export const ok = (s: string) => `${c.mint("✓")} ${s}`;
export const warn = (s: string) => `${c.amber("!")} ${s}`;
export const info = (s: string) => `${c.sky("·")} ${s}`;
export const bad = (s: string) => `${c.rose("✗")} ${s}`;

/** `0x1234…cdef` — long enough to recognise, short enough to tabulate. */
export const short = (addr: string): string =>
  addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

/** Fixed-point with thousands separators, so columns line up on the decimal. */
export function num(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Signed USD, coloured by direction. The `+` is kept: an unsigned PnL reads as a balance. */
export function money(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return c.dim("—");
  const s = `${n >= 0 ? "+" : "−"}$${num(Math.abs(n), dp)}`;
  return n > 0 ? c.mint(s) : n < 0 ? c.rose(s) : c.dim(s);
}

/** A signed position size, coloured long/short. */
export function signedQty(n: number, symbol: string, dp = 4): string {
  if (n === 0) return c.dim(`flat ${symbol}`);
  const s = `${n > 0 ? "+" : "−"}${num(Math.abs(n), dp)} ${symbol}`;
  return n > 0 ? c.mint(s) : c.rose(s);
}

/** A compact bar for relative magnitude inside a table cell. */
export function bar(value: number, max: number, cells = 10): string {
  if (!Number.isFinite(value) || max <= 0) return c.faint("─".repeat(cells));
  const filled = Math.max(0, Math.min(cells, Math.round((Math.abs(value) / max) * cells)));
  const paint = value >= 0 ? c.mint : c.rose;
  return paint("█".repeat(filled)) + c.faint("░".repeat(cells - filled));
}

/** Seconds since a unix timestamp, as `3m ago`. */
export function ago(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function banner(subtitle: string): string {
  const name = `${c.mint("dream")}${c.violet("Copy")}`;
  return `\n${c.bold(name)}  ${c.faint("│")}  ${c.dim(subtitle)}\n`;
}
