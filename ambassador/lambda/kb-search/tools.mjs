/* ---------------------------------------------------------------------------
 * tools.mjs — the agent's tool allowlist and dispatcher.
 *
 * THE AUTHORIZATION BOUNDARY (SPEC 7): the model proposes, deterministic code
 * decides. The model can only REQUEST a call from the list below; this file
 * decides whether it runs and with what arguments. A tool the model can name but
 * that is not in TOOLS is refused, not attempted.
 *
 * v1 is deliberately tiny. Every tool is read-only. Nothing here sends an email,
 * writes to a calendar, or takes an action on a visitor's behalf, so the worst
 * outcome of a successful prompt injection is that the agent says something
 * unhelpful — not that it does something.
 * --------------------------------------------------------------------------- */

import { searchKnowledge } from "./retriever.mjs";

/**
 * Tool schemas sent to OpenAI in the session config.
 *
 * The description is load-bearing: it is the only thing telling the model WHEN
 * to search. "Use this before answering any factual question" belongs here as
 * well as in the system prompt, because tool descriptions survive context
 * pressure better than prompt text.
 */
export const TOOL_SCHEMAS = [
  {
    type: "function",
    name: "search_knowledge",
    description:
      "Search Greg's knowledge base. You MUST call this before answering any " +
      "factual question about Greg — his experience, skills, projects, " +
      "certifications, compensation, or availability. Do not answer from memory " +
      "or inference. If this returns no results, tell the visitor you'd have to " +
      "check with Greg rather than guessing. Search with the visitor's own " +
      "wording; you may call it more than once with different phrasings.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look for, in natural language. e.g. 'Terraform experience', " +
            "'why did DripCheck shut down', 'contract hourly rate'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/**
 * Dispatch a tool call. Returns a JSON-serialisable result for the model.
 *
 * Never throws: a thrown error inside a realtime tool call strands the
 * conversation waiting for output that never arrives. Failures come back as a
 * structured result the model can actually say something about.
 */
export async function dispatchTool(name, rawArgs, ctx) {
  const started = Date.now();

  try {
    if (name !== "search_knowledge") {
      // Not in the allowlist. Refused, not attempted.
      console.warn(JSON.stringify({ msg: "tool_refused", name }));
      return {
        error: "unknown_tool",
        message: "That tool does not exist. Only search_knowledge is available.",
      };
    }

    let args = rawArgs;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        return { error: "bad_arguments", message: "Arguments were not valid JSON." };
      }
    }

    const query = args?.query;
    if (typeof query !== "string" || !query.trim()) {
      return { error: "bad_arguments", message: "A non-empty 'query' string is required." };
    }

    const { results, reason } = await searchKnowledge(query, ctx.apiKey);

    console.log(
      JSON.stringify({
        msg: "tool_call",
        name,
        query: query.slice(0, 120),
        hits: results.length,
        ms: Date.now() - started,
        sessionId: ctx.sessionId,
      })
    );

    if (!results.length) {
      // An empty result is a MEANINGFUL answer, not a failure. Say so
      // explicitly so the model abstains instead of improvising.
      return {
        results: [],
        reason: reason || "no_match",
        instruction:
          "Nothing in the knowledge base matches. Tell the visitor you'd have to " +
          "check with Greg on that and offer his email. Do not guess or infer.",
      };
    }

    return {
      results: results.map((r) => ({
        source: r.id,           // citation id — what the claim auditor checks
        section: r.breadcrumb,
        content: r.text,
      })),
      instruction:
        "Answer using only the content above. Keep it to two or three sentences. " +
        "If it does not cover what was asked, say you'd have to check with Greg.",
    };
  } catch (err) {
    console.error(
      JSON.stringify({ msg: "tool_error", name, error: String(err?.message || err) })
    );
    return {
      error: "tool_failed",
      message:
        "The knowledge base is unavailable right now. Tell the visitor you can't " +
        "look that up at the moment and offer Greg's email.",
    };
  }
}
