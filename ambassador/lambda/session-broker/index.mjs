import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// session-broker  —  Stage 3 (limits, ledger, kill switch)
//
// Connection mode: OpenAI "unified interface" (SPEC 4.1.2).
// The browser NEVER receives an OpenAI credential of any kind.
//
// THE ENFORCEMENT PRINCIPLE (SPEC 7): the model proposes, deterministic code
// decides. Every limit below is checked here, in code the model cannot see,
// argue with, or talk its way past. This Lambda is the ONLY path that can
// create a session, which makes it the correct and only enforcement point.
//
// Runtime: Node 22. Zero npm dependencies.
// ---------------------------------------------------------------------------

const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const MODEL = process.env.OPENAI_MODEL || "gpt-realtime-2.1-mini";
const VOICE = process.env.OPENAI_VOICE || "marin";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 1500);
const KEY_PARAM = process.env.OPENAI_KEY_PARAM || "/ambassador/openai-api-key";
const ENABLED_PARAM = process.env.ENABLED_PARAM || "/ambassador/enabled";
const TABLE = process.env.LIMITS_TABLE || "AmbassadorLimits";

const MAX_SDP_BYTES = Number(process.env.MAX_SDP_BYTES || 32768);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

// --- limits (SPEC 6) ---
const MAX_SESSIONS_PER_IP_24H = Number(process.env.MAX_SESSIONS_PER_IP || 3);
const MAX_SESSIONS_PER_DAY = Number(process.env.MAX_SESSIONS_PER_DAY || 40);
const DAILY_SPEND_CEILING_USD = Number(process.env.DAILY_SPEND_CEILING || 5.0);
// Pre-charged per session. See the PRE-CHARGE note below for why this must be
// a pessimistic worst case rather than an average.
const PROJECTED_SESSION_COST_USD = Number(process.env.PROJECTED_SESSION_COST || 0.25);

const ALLOWED_ORIGINS = new Set([
  "https://gregorychisholm.com",
  "https://www.gregorychisholm.com",
  "http://localhost:8899",
  "http://127.0.0.1:8899",
]);

// System prompt. Assembled by ambassador/scripts/build_prompt.py from
// identity.md + boundaries.md, then uploaded to S3.
//
// WHY S3 AND NOT SSM: the prompt is ~18KB. SSM Standard parameters cap at 4KB
// and Advanced at 8KB, and trimming under 8KB would mean deleting the career
// arc, the self-discussion rules, and the frontend-tension handling — i.e.
// gutting the agent to fit a storage limit. S3 has no such cap, the bucket
// already exists for the KB index, and versioning gives rollback on a bad edit.
const KB_BUCKET = process.env.KB_BUCKET;
const PROMPT_KEY = process.env.PROMPT_S3_KEY || "kb/prompt.txt";

// Minimal fallback if the prompt is unreadable. Deliberately refuses to discuss
// Greg rather than improvising: a broken prompt must not become an ungrounded
// agent. That failure mode is worse than being offline.
const FALLBACK_INSTRUCTIONS = `You are Greg Chisholm's voice agent, but your knowledge base is currently unavailable.
Say exactly this and nothing more: "I'm Greg's voice agent, but I can't reach my knowledge base right now, so I'd rather not guess about his experience. You can email him at gchis66@gmail.com."
Do not answer questions about Greg. Do not invent anything.`;

// The agent's only tool. See ambassador/lambda/kb-search/tools.mjs — the schema
// is duplicated here because the session config must declare it at setup, while
// execution happens in a different Lambda. Keep the two in sync.
const TOOL_SCHEMAS = [
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

const ssm = new SSMClient({});
const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/* ---------------------------- prompt cache ------------------------------ */
// Cached in module scope: a warm Lambda reads S3 once, not once per session.
// TTL is longer than the SSM param cache because the prompt changes rarely and
// an 18KB fetch is not free.
let promptCache = null;
const PROMPT_TTL_MS = 5 * 60 * 1000;

async function getSystemPrompt() {
  if (promptCache && Date.now() - promptCache.at < PROMPT_TTL_MS) {
    return promptCache.value;
  }
  if (!KB_BUCKET) throw new Error("KB_BUCKET not set");

  const res = await s3.send(
    new GetObjectCommand({ Bucket: KB_BUCKET, Key: PROMPT_KEY })
  );
  const value = await res.Body.transformToString();

  // A truncated or empty prompt is worse than no prompt: the agent would keep
  // its voice but lose its rules. Treat it as unreadable.
  if (!value || value.length < 2000) {
    throw new Error(`prompt too short (${value?.length ?? 0} chars) — truncated?`);
  }

  promptCache = { value, at: Date.now() };
  console.log(JSON.stringify({ msg: "prompt_loaded", chars: value.length }));
  return value;
}

/* ------------------------------ param cache ----------------------------- */

const cache = new Map(); // name -> { value, at }
const PARAM_TTL_MS = 60 * 1000; // short, so the kill switch takes effect fast

async function getParam(name, decrypt = false) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < PARAM_TTL_MS) return hit.value;

  const out = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: decrypt })
  );
  const value = out?.Parameter?.Value;
  if (value == null) throw new Error(`SSM parameter empty: ${name}`);

  cache.set(name, { value, at: Date.now() });
  return value;
}

/* -------------------------------- helpers ------------------------------- */

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function hashIp(ip) {
  return createHash("sha256")
    .update(`ambassador:${ip || "unknown"}`)
    .digest("hex")
    .slice(0, 32);
}

function corsHeaders(origin) {
  const h = { Vary: "Origin", "Cache-Control": "no-store" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

function fail(status, code, origin, detail, extra = {}) {
  if (detail) console.error(`[${code}]`, detail);
  return {
    statusCode: status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    body: JSON.stringify({ error: code, ...extra }),
  };
}

/* ----------------------------- limit checks ----------------------------- */
//
// Order matters: cheapest and most-likely-to-trip first, and the two counters
// that consume budget are incremented LAST so a rejection does not burn quota.

/** Kill switch. A single SSM value disables the whole feature. */
async function checkEnabled() {
  const v = (await getParam(ENABLED_PARAM)).trim().toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/**
 * Per-IP sessions in a rolling 24h window, via a TTL'd counter item.
 * Atomic: ADD + a condition that the post-increment value stays within budget.
 */
async function reserveIpSlot(ipHash) {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `ip#${ipHash}` },
        UpdateExpression:
          "ADD #n :one SET #ttl = if_not_exists(#ttl, :exp), firstSeen = if_not_exists(firstSeen, :now)",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :max",
        ExpressionAttributeNames: { "#n": "sessions", "#ttl": "expiresAt" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":max": MAX_SESSIONS_PER_IP_24H,
          ":exp": nowSec + 86400,
          ":now": nowSec,
        },
      })
    );
    return { ok: true };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { ok: false, reason: "ip_limit" };
    }
    throw err;
  }
}

/** Global session count + pre-charged spend for the current UTC day. */
async function reserveDailyBudget() {
  const day = todayUTC();
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const res = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `day#${day}` },
        UpdateExpression:
          "ADD sessions :one, spendUsd :cost SET #ttl = if_not_exists(#ttl, :exp)",
        ConditionExpression:
          "(attribute_not_exists(sessions) OR sessions < :maxS) AND (attribute_not_exists(spendUsd) OR spendUsd < :maxSpend)",
        ExpressionAttributeNames: { "#ttl": "expiresAt" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":cost": PROJECTED_SESSION_COST_USD,
          ":maxS": MAX_SESSIONS_PER_DAY,
          ":maxSpend": DAILY_SPEND_CEILING_USD,
          ":exp": nowSec + 86400 * 40, // keep ~40 days for trend visibility
        },
        ReturnValues: "UPDATED_NEW",
      })
    );
    return { ok: true, after: res.Attributes };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { ok: false, reason: "daily_limit" };
    }
    throw err;
  }
}

/** Give back an IP slot and day budget when the upstream call fails. */
async function releaseReservations(ipHash) {
  const day = todayUTC();
  const undo = [
    db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `ip#${ipHash}` },
        UpdateExpression: "ADD sessions :neg",
        ConditionExpression: "sessions > :zero",
        ExpressionAttributeValues: { ":neg": -1, ":zero": 0 },
      })
    ),
    db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `day#${day}` },
        UpdateExpression: "ADD sessions :neg, spendUsd :negCost",
        ConditionExpression: "sessions > :zero",
        ExpressionAttributeValues: {
          ":neg": -1,
          ":negCost": -PROJECTED_SESSION_COST_USD,
          ":zero": 0,
        },
      })
    ),
  ];
  const results = await Promise.allSettled(undo);
  results.forEach((r, i) => {
    if (r.status === "rejected" && r.reason?.name !== "ConditionalCheckFailedException") {
      console.error("[release_failed]", i, r.reason?.message);
    }
  });
}

/* -------------------------------- handler ------------------------------- */

export const handler = async function (event) {
  const headers = event?.headers || {};
  const origin = headers.origin || headers.Origin || "";
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }
  if (method !== "POST") return fail(405, "method_not_allowed", origin);

  if (!ALLOWED_ORIGINS.has(origin)) {
    return fail(403, "origin_not_allowed", origin, `origin=${origin}`);
  }

  // --- body: raw offer SDP ---
  let sdp = event?.body || "";
  if (event?.isBase64Encoded) sdp = Buffer.from(sdp, "base64").toString("utf8");

  if (!sdp || !sdp.startsWith("v=")) {
    return fail(400, "invalid_sdp", origin, `len=${sdp.length}`);
  }
  if (Buffer.byteLength(sdp, "utf8") > MAX_SDP_BYTES) {
    return fail(413, "sdp_too_large", origin, `bytes=${Buffer.byteLength(sdp)}`);
  }

  const ip = event?.requestContext?.http?.sourceIp || "";
  const ipHash = hashIp(ip);
  const sessionId = `s_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  // ---------------------------------------------------------------------
  // LIMIT GATE. Every failure below FAILS CLOSED: if a check cannot be
  // completed, the session is refused. An unavailable limiter must never
  // become an open door.
  // ---------------------------------------------------------------------

  // 1. kill switch
  try {
    if (!(await checkEnabled())) {
      console.log(JSON.stringify({ msg: "refused", sessionId, reason: "disabled" }));
      return fail(503, "temporarily_disabled", origin);
    }
  } catch (err) {
    return fail(503, "config_unavailable", origin, `enabled: ${err?.message}`);
  }

  // 2. per-IP rolling window
  let ipReserved = false;
  try {
    const r = await reserveIpSlot(ipHash);
    if (!r.ok) {
      console.log(JSON.stringify({ msg: "refused", sessionId, reason: r.reason, ipHash }));
      return fail(429, "ip_limit", origin, null, {
        message: `Limit of ${MAX_SESSIONS_PER_IP_24H} conversations per day reached.`,
      });
    }
    ipReserved = true;
  } catch (err) {
    return fail(503, "limiter_unavailable", origin, `ip: ${err?.message}`);
  }

  // 3. global daily sessions + pre-charged spend
  try {
    const r = await reserveDailyBudget();
    if (!r.ok) {
      // roll back the IP slot we just took
      await releaseReservations(ipHash).catch(() => {});
      console.log(JSON.stringify({ msg: "refused", sessionId, reason: r.reason }));
      return fail(429, "daily_limit", origin, null, {
        message: "Daily budget for the voice agent is spent. Try again tomorrow.",
      });
    }
    console.log(
      JSON.stringify({
        msg: "reserved",
        sessionId,
        daySessions: r.after?.sessions,
        daySpendUsd: Number(r.after?.spendUsd || 0).toFixed(2),
      })
    );
  } catch (err) {
    await releaseReservations(ipHash).catch(() => {});
    return fail(503, "limiter_unavailable", origin, `day: ${err?.message}`);
  }

  // --- credential + system prompt ---
  let apiKey;
  let instructions;
  try {
    apiKey = await getParam(KEY_PARAM, true);
  } catch (err) {
    await releaseReservations(ipHash).catch(() => {});
    return fail(503, "config_unavailable", origin, err?.message);
  }

  try {
    instructions = await getSystemPrompt();
  } catch (err) {
    // Do NOT fail the session — degrade to an agent that refuses to discuss
    // Greg. An unreadable prompt must never become an ungrounded agent.
    console.error(`[prompt_unavailable] ${err?.message}`);
    instructions = FALLBACK_INSTRUCTIONS;
  }

  // --- upstream ---
  // `session` must be a JSON *string* field. An object or Blob becomes a file
  // part and OpenAI 400s without naming the field.
  const sessionConfig = JSON.stringify({
    type: "realtime",
    model: MODEL,
    audio: {
      input: {
        transcription: { model: TRANSCRIBE_MODEL },
        noise_reduction: { type: "near_field" },
      },
      output: { voice: VOICE },
    },
    instructions: instructions,
    tools: TOOL_SCHEMAS,
    tool_choice: "auto",
    max_output_tokens: MAX_OUTPUT_TOKENS,
  });

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", sessionConfig);

  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(OPENAI_CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": ipHash,
      },
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    await releaseReservations(ipHash).catch(() => {});
    return fail(504, "upstream_unreachable", origin, err?.message);
  }

  const elapsed = Date.now() - started;

  if (!upstream.ok) {
    let detail = "";
    try {
      detail = (await upstream.text()).slice(0, 800);
    } catch {
      detail = "<unreadable>";
    }
    console.error(
      JSON.stringify({
        msg: "openai_error",
        sessionId,
        status: upstream.status,
        elapsed,
        model: MODEL,
        detail,
      })
    );
    // No session was created, so refund the reservation.
    await releaseReservations(ipHash).catch(() => {});
    return fail(502, "upstream_error", origin);
  }

  const answerSdp = await upstream.text();

  console.log(
    JSON.stringify({
      msg: "session_created",
      sessionId,
      elapsed,
      model: MODEL,
      voice: VOICE,
      sdpInBytes: Buffer.byteLength(sdp, "utf8"),
      sdpOutBytes: Buffer.byteLength(answerSdp, "utf8"),
    })
  );

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/sdp",
      "X-Session-Id": sessionId,
    },
    body: answerSdp,
  };
};
