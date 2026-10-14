import { MultiSelectPrompt, type State } from "@clack/core";
import pc from "picocolors";

type Option<T> = { value: T; label: string; hint?: string };

/**
 * Spinner text must fit on one line: a spinner redraws only its own line, so text that wraps leaves a copy of
 * itself on screen every frame. Long explanations go in a log line instead; this trims what's left.
 */
export function fit(text: string, reserve = 8): string {
  const width = Math.max(20, (process.stdout.columns || 80) - reserve);
  // Measure without colour codes; cut (and drop colours) only when it doesn't fit.
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.length <= width ? text : `${plain.slice(0, width - 1)}…`;
}

const symbol = (state: State) =>
  state === "submit" ? pc.green("◇") : state === "cancel" ? pc.red("■") : state === "error" ? pc.yellow("▲") : pc.cyan("◆");

/**
 * A checkbox list that reads like one: `[✔] iOS` / `[ ] Android`. Clack's own multiselect draws filled squares,
 * which look like a colour swatch rather than a choice.
 */
export function checkboxes<T>(opts: { message: string; options: Option<T>[]; initialValues?: T[]; required?: boolean }): Promise<T[] | symbol> {
  const required = opts.required ?? true;
  return new MultiSelectPrompt<Option<T>>({
    options: opts.options,
    initialValues: opts.initialValues,
    required,
    validate(value) {
      if (required && !value?.length) return "Select at least one: space to select, enter to confirm";
    },
    render() {
      const selected = (this.value ?? []) as T[];
      const bar = this.state === "error" ? pc.yellow("│") : this.state === "submit" || this.state === "cancel" ? pc.gray("│") : pc.cyan("│");
      const title = `${pc.gray("│")}\n${symbol(this.state)}  ${opts.message}\n`;
      if (this.state === "submit" || this.state === "cancel") {
        const chosen = this.options.filter((o) => selected.includes(o.value)).map((o) => o.label);
        const text = chosen.join(", ") || "none";
        return `${title}${bar}  ${this.state === "cancel" ? pc.strikethrough(pc.dim(text)) : pc.dim(text)}`;
      }
      const lines = this.options.map((o, i) => {
        const on = selected.includes(o.value);
        const active = i === this.cursor;
        const box = on ? pc.green("[✔]") : active ? pc.cyan("[ ]") : pc.dim("[ ]");
        const label = active ? pc.bold(o.label) : o.label;
        return `${bar}  ${box} ${label}${o.hint ? ` ${pc.dim(`(${o.hint})`)}` : ""}`;
      });
      const footer = this.state === "error" ? `${pc.yellow("└")}  ${pc.yellow(this.error)}` : `${pc.cyan("└")}  ${pc.dim("↑/↓ move · space select · enter confirm")}`;
      return `${title}${lines.join("\n")}\n${footer}\n`;
    },
  }).prompt() as Promise<T[] | symbol>;
}
