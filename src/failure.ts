/**
 * Why a build failed, in the build tools' own words. Every tool marks its error the same way every time:
 * Gradle's "* What went wrong:" block, Xcode's "error:" lines, npm's "ERR!". So this looks for those
 * sections instead of matching known failures, and works for errors nobody has seen yet.
 */
export type LogLine = { text: string; stream?: string };

const ANSI = /\x1b\[[0-9;]*m/g;
/** Stack frames and other lines that are never the reason. */
const NOISE = /^\s*(at |\.\.\. \d+ more|Caused by: org\.gradle|org\.gradle\.|java\.|kotlin\.|\(Use `node --trace)/;
const ERROR_LINE = /(^|\s)(error|fatal error|fatal|ERROR|Error)(\[[^\]]*\])?:\s|npm ERR!|^npm error\b|\*\* (ARCHIVE|BUILD|EXPORT|TEST) FAILED \*\*|^\[!\]\s|FAILURE: /;

const clean = (t: string) => t.replace(ANSI, "").replace(/^! ?/, "").trimEnd();
const unique = (lines: string[]) => lines.filter((l, i) => l.trim() && lines.indexOf(l) === i);

function lastIndex(lines: string[], test: (l: string) => boolean, before = lines.length) {
  for (let i = before - 1; i >= 0; i--) if (test(lines[i]!)) return i;
  return -1;
}

/** The lines that explain the failure, or [] when no tool marked one (then show the end of the log). */
export function whyItFailed(log: LogLine[]): string[] {
  const lines = log.map((l) => clean(l.text));
  // The runner's own one-line reason ("Gradle assembleRelease failed: exit status 1"), said last.
  const runner = [...log].reverse().find((l) => l.stream === "system" && /\bfailed\b/i.test(l.text));
  const tail = runner ? [clean(runner.text)] : [];

  // Gradle: "* What went wrong:" up to "* Try:", plus the errors printed just before the failure (a tool
  // that Gradle ran usually says the real reason there, like sentry-cli's "error: Auth token is required").
  const wrong = lastIndex(lines, (l) => l.trim() === "* What went wrong:");
  if (wrong >= 0) {
    const block: string[] = [];
    for (let i = wrong + 1; i < lines.length && !/^\* (Try|Exception is|Get more help|Where)/.test(lines[i]!.trim()); i++) block.push(lines[i]!);
    const failure = lastIndex(lines, (l) => l.startsWith("FAILURE: "), wrong);
    const start = failure >= 0 ? failure : wrong;
    const before = lines.slice(Math.max(0, start - 80), start).filter((l) => ERROR_LINE.test(l) && !NOISE.test(l));
    return unique([...before.slice(-8), ...block.slice(0, 20).map((l) => l.trim()), ...tail]);
  }

  // Xcode, CocoaPods, npm and friends: their error lines, without stack frames.
  const errors = lines.filter((l) => ERROR_LINE.test(l) && !NOISE.test(l) && !/\b0 errors?\b/.test(l));
  if (errors.length) return unique([...unique(errors).slice(-15), ...tail]);
  return tail;
}
