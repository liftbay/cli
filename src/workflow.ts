import { WORKFLOW_YAML } from "./generated/workflow.ts";
import { apiUrl } from "./context.ts";

export const WORKFLOW_PATH = ".github/workflows/liftbay.yml";

/**
 * The build workflow as Liftbay runs it today, from the API, so a workflow fix reaches every repo with a server
 * deploy, whatever CLI version wrote the old one. Offline, the copy this CLI was released with.
 */
export async function currentWorkflow(): Promise<string> {
  try {
    const res = await fetch(`${apiUrl()}/v1/github/workflow`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { content?: unknown };
      if (typeof body.content === "string" && body.content.includes("liftbay")) return body.content;
    }
  } catch {
    // Offline or an older server: the bundled copy below.
  }
  return WORKFLOW_YAML;
}
