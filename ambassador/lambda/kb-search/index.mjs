import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

import { dispatchTool } from "./tools.mjs";

// ---------------------------------------------------------------------------
// kb-search — executes the agent's ONE tool.
//
// WHY THIS IS A SEPARATE LAMBDA FROM session-broker:
// Audio AND the data channel are peer-to-peer between the browser and OpenAI.
// The session broker sits in session *setup* only, so it never sees a tool call.
// Tool calls arrive at the BROWSER, which cannot hold the OpenAI key (needed to
// embed the query) and must not download the 3.4MB index. So the browser calls
// this endpoint instead.
//
// This is a real cost of the peer-to-peer design, not an accident of it. Any
// architecture that keeps audio out of our infrastructure has this property.
//
// THIS ENDPOINT IS ITS OWN COST SURFACE. It calls a paid embeddings API, so it
// needs its own rate limiting — otherwise a visitor can burn embedding spend
// without ever opening a session, bypassing every control in the session broker.
// ---------------------------------------------------------------------------

const KEY_PARAM = process.env.OPENAI_KEY_PARAM || "/ambassador/openai-api-key";
const ENABLED_PARAM = process.env.ENABLED_PARAM || "/ambassador/enabled";
const TABLE = process.env.LIMITS_TABLE || "AmbassadorLimits";

// Generous per-visitor allowance: a real 5-minute conversation might legitimately
// make 10-20 searches. Low enough to bound abuse, high enough never to bite a
// genuine visitor.
const MAX_SEARCHES_PER_IP_24H = Number(process.env.MAX_SEARCHES_PER_IP || 120);
const MAX_QUERY_CHARS = 500;

const ALLOWED_ORIGINS = new Set([
  "https://gregorychisholm.com",
  "https://www.gregorychisholm.com",
  "http://localhost:8899",
  "http://127.0.0.1:8899",
]);

const ssm = new SSMClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const cache = new Map();
const PARAM_TTL_MS = 60 * 1000;

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

function json(status, origin, body) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Atomic per-IP search budget, TTL'd to 24h. */
async function reserveSearch(ipHash) {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `search#${ipHash}` },
        UpdateExpression:
          "ADD #n :one SET #ttl = if_not_exists(#ttl, :exp)",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :max",
        ExpressionAttributeNames: { "#n": "searches", "#ttl": "expiresAt" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":max": MAX_SEARCHES_PER_IP_24H,
          ":exp": nowSec + 86400,
        },
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export const handler = async function (event) {
  const headers = event?.headers || {};
  const origin = headers.origin || headers.Origin || "";
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }
  if (method !== "POST") return json(405, origin, { error: "method_not_allowed" });

  if (!ALLOWED_ORIGINS.has(origin)) {
    console.error(`[origin_not_allowed] ${origin}`);
    return json(403, origin, { error: "origin_not_allowed" });
  }

  // --- parse ---
  let body;
  try {
    let raw = event?.body || "{}";
    if (event?.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
    body = JSON.parse(raw);
  } catch {
    return json(400, origin, { error: "bad_json" });
  }

  const query = body?.query;
  if (typeof query !== "string" || !query.trim()) {
    return json(400, origin, { error: "bad_arguments", message: "query required" });
  }
  if (query.length > MAX_QUERY_CHARS) {
    return json(413, origin, { error: "query_too_long" });
  }

  const ipHash = hashIp(event?.requestContext?.http?.sourceIp || "");

  // --- kill switch (fail closed) ---
  try {
    const enabled = (await getParam(ENABLED_PARAM)).trim().toLowerCase();
    if (!["true", "1", "on"].includes(enabled)) {
      return json(503, origin, { error: "temporarily_disabled" });
    }
  } catch (err) {
    console.error(`[config_unavailable] ${err?.message}`);
    return json(503, origin, { error: "config_unavailable" });
  }

  // --- per-IP search budget (fail closed) ---
  try {
    if (!(await reserveSearch(ipHash))) {
      console.log(JSON.stringify({ msg: "search_refused", reason: "ip_limit", ipHash }));
      // 200 with an empty result, deliberately: the model is mid-conversation and
      // needs something it can say. A 429 here would strand the tool call.
      return json(200, origin, {
        results: [],
        reason: "rate_limited",
        instruction:
          "You've hit the lookup limit for this visitor. Tell them you can't look " +
          "anything else up right now and offer Greg's email.",
      });
    }
  } catch (err) {
    console.error(`[limiter_unavailable] ${err?.message}`);
    return json(503, origin, { error: "limiter_unavailable" });
  }

  // --- credential ---
  let apiKey;
  try {
    apiKey = await getParam(KEY_PARAM, true);
  } catch (err) {
    console.error(`[config_unavailable] key: ${err?.message}`);
    return json(503, origin, { error: "config_unavailable" });
  }

  // --- execute ---
  const sessionId = body?.sessionId || "unknown";
  const result = await dispatchTool("search_knowledge", { query }, { apiKey, sessionId });

  return json(200, origin, result);
};
