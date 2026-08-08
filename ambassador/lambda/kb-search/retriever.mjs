import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// retriever — loads the KB index from S3 and does cosine similarity in-process.
//
// WHY NO VECTOR DATABASE: 109 chunks x 1536 dims is ~3.4MB and a brute-force
// scan is sub-millisecond. OpenSearch or S3 Vectors would add a service, a cost,
// and a failure mode to solve a problem that does not exist at this scale.
// Revisit past ~5,000 chunks.
//
// The index is cached in module scope, so a warm Lambda pays the S3 read once.
// ---------------------------------------------------------------------------

const s3 = new S3Client({});

const BUCKET = process.env.KB_BUCKET;
const INDEX_KEY = process.env.KB_INDEX_KEY || "kb/index.json";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const TOP_K = Number(process.env.RETRIEVE_TOP_K || 4);
// Below this cosine score a chunk is noise. Returning nothing is correct here:
// it makes the agent abstain rather than answer from an irrelevant chunk.
const MIN_SCORE = Number(process.env.RETRIEVE_MIN_SCORE || 0.28);

let INDEX = null;

async function loadIndex() {
  if (INDEX) return INDEX;
  if (!BUCKET) throw new Error("KB_BUCKET not set");

  const res = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: INDEX_KEY })
  );
  const parsed = JSON.parse(await res.Body.transformToString());

  if (!parsed?.chunks?.length) throw new Error("KB index empty or malformed");
  if (parsed.model !== EMBED_MODEL) {
    // Query and document vectors MUST come from the same model or the
    // similarity scores are meaningless. Fail loudly.
    throw new Error(
      `index model ${parsed.model} != query model ${EMBED_MODEL}`
    );
  }

  // Pre-compute norms once, not per query.
  for (const c of parsed.chunks) {
    let s = 0;
    for (const v of c.vector) s += v * v;
    c._norm = Math.sqrt(s);
  }

  INDEX = parsed;
  console.log(
    JSON.stringify({ msg: "kb_loaded", chunks: parsed.chunks.length, dim: parsed.dim })
  );
  return INDEX;
}

async function embedQuery(text, apiKey) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    // Log the upstream body — a 400 here is a request-shape bug, and the body
    // names the field. Same lesson as the multipart session config.
    const detail = await res.text().catch(() => "<unreadable>");
    console.error(JSON.stringify({ msg: "embed_error", status: res.status, detail: detail.slice(0, 400) }));
    throw new Error(`embed failed: ${res.status}`);
  }

  const json = await res.json();
  return json.data[0].embedding;
}

function cosine(q, qNorm, chunk) {
  const v = chunk.vector;
  let dot = 0;
  for (let i = 0; i < v.length; i++) dot += q[i] * v[i];
  const denom = qNorm * chunk._norm;
  return denom ? dot / denom : 0;
}

/**
 * search_knowledge — the only way the agent can learn a fact about Greg.
 *
 * Returns { results: [{ id, breadcrumb, text, score }] }.
 * An empty array is a valid, meaningful answer: no source, so the agent must
 * abstain. This is the enforcement point of the grounding contract.
 */
export async function searchKnowledge(query, apiKey, { topK = TOP_K } = {}) {
  const q = String(query || "").trim();
  if (!q) return { results: [], reason: "empty_query" };
  if (q.length > 500) return { results: [], reason: "query_too_long" };

  const index = await loadIndex();
  const qv = await embedQuery(q, apiKey);

  let qNorm = 0;
  for (const v of qv) qNorm += v * v;
  qNorm = Math.sqrt(qNorm);

  const scored = index.chunks
    .map((c) => ({ chunk: c, score: cosine(qv, qNorm, c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((r) => r.score >= MIN_SCORE);

  console.log(
    JSON.stringify({
      msg: "kb_search",
      query: q.slice(0, 120),
      hits: scored.length,
      top: scored[0]?.chunk.id ?? null,
      topScore: scored[0]?.score?.toFixed(3) ?? null,
    })
  );

  return {
    results: scored.map((r) => ({
      // The citation id. This is what makes the async claim auditor possible.
      id: r.chunk.chunk_id ?? r.chunk.id,
      breadcrumb: r.chunk.breadcrumb,
      text: r.chunk.text,
      score: Number(r.score.toFixed(4)),
    })),
  };
}

export const _internal = { loadIndex };
