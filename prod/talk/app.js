/* ---------------------------------------------------------------------------
 * Ambassador voice agent: browser client (Stage 1 walking skeleton)
 *
 * Flow (OpenAI "unified interface", SPEC 4.1.2):
 *   1. createOffer() locally
 *   2. POST the offer SDP to our own Lambda  (Content-Type: application/sdp)
 *   3. Lambda attaches session config + our API key, forwards to OpenAI
 *   4. setRemoteDescription(answer)
 *   5. Audio then flows peer-to-peer, browser <-> OpenAI
 *
 * No OpenAI credential is ever present in this file or in the browser.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Endpoints. Set by index.html.
 *   AMBASSADOR_SESSION_URL  POST offer SDP -> answer SDP   (session-broker)
 *   AMBASSADOR_SEARCH_URL   POST { query } -> KB results   (kb-search)
 *
 * Why the browser executes tool calls: audio AND the data channel are
 * peer-to-peer between this browser and OpenAI, so the model's tool-call events
 * arrive HERE, never at the Lambda. The browser cannot hold the OpenAI key or
 * the index, so it proxies each search to kb-search.
 * ------------------------------------------------------------------------- */
const SESSION_ENDPOINT = window.AMBASSADOR_SESSION_URL || "/session";
const SEARCH_ENDPOINT = window.AMBASSADOR_SEARCH_URL || "/kb-search";
const MAX_SESSION_MS = 5 * 60 * 1000; // hard cap, SPEC 6
const WARN_AT_MS = 30 * 1000;         // warn 30s before cutoff

const state = {
  pc: null,
  dc: null,
  micStream: null,
  audioEl: null,
  timer: null,
  warnTimer: null,
  status: "idle", // idle | connecting | live | ending | error
  usage: { turns: 0, audioIn: 0, audioOut: 0, cached: 0, input: 0, output: 0 },
};

/* --------------------------- tiny UI helpers --------------------------- */

const els = {};
function cacheEls() {
  els.startBtn = document.getElementById("startBtn");
  els.stage = document.getElementById("stage");
  els.orb = document.querySelector(".orb");
  els.statusText = document.getElementById("statusText");
  els.statusSub = document.getElementById("statusSub");
  els.transcript = document.getElementById("transcript");
}

function setStatus(status, text, sub) {
  state.status = status;
  if (els.statusText && text != null) els.statusText.textContent = text;
  if (els.statusSub && sub != null) els.statusSub.textContent = sub;
  if (els.stage) els.stage.dataset.status = status;
  if (els.orb) els.orb.dataset.status = status;
}

function setButton(label, disabled) {
  if (!els.startBtn) return;
  els.startBtn.textContent = label;
  els.startBtn.classList.toggle("disabled", !!disabled);
  els.startBtn.setAttribute("aria-disabled", disabled ? "true" : "false");
}

function logLine(role, text) {
  if (!els.transcript || !text) return;
  const p = document.createElement("p");
  p.className = `line line-${role}`;
  p.innerHTML = `<span class="who">${role === "user" ? "You" : "Agent"}</span>${escapeHtml(text)}`;
  els.transcript.appendChild(p);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  els.transcript.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ------------------------------ session ------------------------------- */

async function startSession() {
  if (state.status === "connecting" || state.status === "live") return;

  // getUserMedia requires a secure context. localhost counts as secure; a LAN
  // IP over plain http does NOT, and fails with no obvious explanation.
  if (!window.isSecureContext) {
    setStatus("error", "Needs a secure connection",
      "Microphone access requires HTTPS (or localhost).");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("error", "Browser not supported",
      "This browser does not expose microphone access.");
    return;
  }

  setStatus("connecting", "Connecting…", "Requesting microphone access.");
  setButton("Connecting…", true);

  try {
    /* 1. mic ---------------------------------------------------------- */
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    /* 2. peer connection --------------------------------------------- */
    const pc = new RTCPeerConnection();
    state.pc = pc;

    state.audioEl = document.createElement("audio");
    state.audioEl.autoplay = true;
    pc.ontrack = (e) => {
      state.audioEl.srcObject = e.streams[0];
    };

    pc.addTrack(state.micStream.getAudioTracks()[0], state.micStream);

    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        if (state.status === "live") endSession("Connection lost.");
      }
    };

    /* 3. data channel for events ------------------------------------- */
    const dc = pc.createDataChannel("oai-events");
    state.dc = dc;
    dc.addEventListener("open", () => {
      setStatus("live", "Listening", "Speak whenever you're ready.");
      setButton("End conversation", false);
    });
    dc.addEventListener("message", (e) => handleEvent(e.data));

    /* 4. offer -> our Lambda -> answer -------------------------------- */
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    setStatus("connecting", "Connecting…", "Negotiating session.");

    const res = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp" },
    });

    if (!res.ok) {
      let code = `HTTP ${res.status}`;
      let serverMsg = "";
      try {
        const j = await res.json();
        if (j?.error) code = j.error;
        if (j?.message) serverMsg = j.message;
      } catch { /* body was not json */ }
      const e = new Error(code);
      e.serverMessage = serverMsg;
      e.httpStatus = res.status;
      throw e;
    }

    const answerSdp = await res.text();
    // The broker returns its session id; carry it so kb-search logs correlate
    // with session-broker logs for the same conversation.
    state.sessionId = res.headers.get("X-Session-Id") || null;
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    /* 5. hard session cap -------------------------------------------- */
    state.warnTimer = setTimeout(() => {
      if (state.status === "live") {
        setStatus("live", "Wrapping up", "About 30 seconds left in this session.");
      }
    }, MAX_SESSION_MS - WARN_AT_MS);

    state.timer = setTimeout(() => {
      endSession("Session limit reached (5 minutes).");
    }, MAX_SESSION_MS);

  } catch (err) {
    console.error("[ambassador] start failed:", err);
    cleanup();

    if (err?.name === "NotAllowedError") {
      setStatus("error", "Microphone blocked",
        "Permission was denied. Allow mic access and try again.");
      setButton("Try again", false);
      return;
    }

    // A limit is not an error the visitor caused, so present it plainly and
    // always leave the email path visible.
    const isLimit = err?.code === "ip_limit" || err?.message === "ip_limit" ||
                    err?.message === "daily_limit";
    const isOff = err?.message === "temporarily_disabled";

    if (isLimit || isOff) {
      setStatus("limited",
        isOff ? "Temporarily offline" : "Conversation limit reached",
        err.serverMessage || friendlyError(err?.message));
      setButton("Email me instead", false);
      if (els.startBtn) {
        els.startBtn.dataset.mode = "email";
        els.startBtn.setAttribute("href",
          "mailto:gchis66@gmail.com?subject=Let%27s%20talk");
      }
      return;
    }

    setStatus("error", "Could not start",
      err.serverMessage || friendlyError(err?.message));
    setButton("Try again", false);
  }
}

function friendlyError(code) {
  switch (code) {
    case "ip_limit":            return "You've reached the conversation limit for today.";
    case "daily_limit":         return "Today's budget for the voice agent is spent. Try again tomorrow.";
    case "temporarily_disabled":return "The voice agent is switched off right now.";
    case "limiter_unavailable": return "Can't verify limits right now, so the session was refused.";
    case "origin_not_allowed":  return "This page is not an allowed origin.";
    case "config_unavailable":  return "The agent is not configured. Try later.";
    case "upstream_error":      return "The voice service rejected the session.";
    case "upstream_unreachable":return "The voice service timed out.";
    case "sdp_too_large":
    case "invalid_sdp":         return "The browser sent an invalid session offer.";
    default:                    return code || "Unknown error.";
  }
}

/* ---------------------------- cost estimate ----------------------------- */

// $/1M tokens, gpt-realtime-2.1-mini. Rough. OpenAI's dashboard is authoritative.
const RATE = { audioOut: 20.0, audioIn: 10.0, cachedIn: 0.06, textIn: 0.60 };

/**
 * Estimate spend for a session from cumulative usage.
 *
 * The trap: `cached_tokens` counts ALL cached input, the ~4.6k-token system
 * prompt plus previously-sent audio, so it dwarfs `audioIn` and must never be
 * subtracted from it. Uncached input is (input - cached), which is what actually
 * gets billed at the full rate.
 */
function estimateCost(u) {
  const uncachedIn = Math.max((u.input || 0) - (u.cached || 0), 0);
  return (
    u.audioOut * RATE.audioOut +
    u.cached * RATE.cachedIn +
    uncachedIn * RATE.textIn
  ) / 1e6;
}

/* ---------------------------- data channel ----------------------------- */

/** Send a client event over the realtime data channel. No-op if not open. */
function send(obj) {
  if (state.dc?.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
    return true;
  }
  console.warn("[ambassador] data channel not open, dropped:", obj.type);
  return false;
}

/* ---------------------------- tool calls ------------------------------- */

/**
 * Execute a model-requested tool call and return the result over the data
 * channel.
 *
 * CRITICAL: every path must send a function_call_output. If we return nothing,
 * the model waits forever for output that never arrives and the conversation
 * dies mid-sentence with no error the visitor can understand. Failures are
 * therefore reported as *results* the model can talk about, never as silence.
 */
async function handleToolCall(evt) {
  const callId = evt.call_id;
  const name = evt.name;
  if (!callId) return;

  if (state.status === "live") setStatus("live", "Looking it up", "");

  let output;
  try {
    if (name !== "search_knowledge") {
      // Allowlist is enforced server-side too; this is defence in depth.
      output = { error: "unknown_tool", message: "That tool does not exist." };
    } else {
      let args = {};
      try {
        args = JSON.parse(evt.arguments || "{}");
      } catch {
        args = {};
      }

      const res = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: args.query || "", sessionId: state.sessionId }),
        signal: AbortSignal.timeout(9000),
      });

      if (!res.ok) {
        let code = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) code = j.error;
        } catch { /* not json */ }
        console.warn("[ambassador] kb-search failed:", code);
        output = {
          error: code,
          instruction:
            "The knowledge base is unavailable. Tell the visitor you can't look " +
            "that up right now and offer Greg's email. Do not guess.",
        };
      } else {
        output = await res.json();
        const n = output?.results?.length ?? 0;
        state.searches = (state.searches || 0) + 1;
        console.log(
          `[ambassador] kb-search "${(JSON.parse(evt.arguments || "{}").query || "").slice(0, 60)}" -> ${n} hits` +
          (n ? ` (${output.results.map((r) => r.source).join(", ")})` : "")
        );
        // Record citations so the transcript can be audited afterward.
        if (n) {
          state.citations = state.citations || new Set();
          for (const r of output.results) state.citations.add(r.source);
        }
      }
    }
  } catch (err) {
    console.error("[ambassador] tool call threw:", err);
    output = {
      error: "tool_failed",
      instruction:
        "The lookup failed. Tell the visitor you can't check that right now and " +
        "offer Greg's email. Do not guess.",
    };
  }

  // Hand the result back, then ask the model to continue speaking.
  send({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output),
    },
  });
  send({ type: "response.create" });

  if (state.status === "live") setStatus("live", "Thinking", "");
}

/* ------------------------- realtime events ---------------------------- */

function handleEvent(raw) {
  let evt;
  try { evt = JSON.parse(raw); } catch { return; }

  switch (evt.type) {
    // visitor speech, transcribed
    case "conversation.item.input_audio_transcription.completed":
      logLine("user", evt.transcript);
      break;

    // agent speech, transcribed as it is produced
    case "response.output_audio_transcript.done":
      logLine("agent", evt.transcript);
      break;

    case "input_audio_buffer.speech_started":
      if (state.status === "live") setStatus("live", "Listening", "Go ahead.");
      break;

    case "response.created":
      if (state.status === "live") setStatus("live", "Thinking", "");
      break;

    case "output_audio_buffer.started":
      if (state.status === "live") setStatus("live", "Speaking", "");
      break;

    // ---- TOOL CALLS ----
    // The model has finished emitting arguments for a function call. This is
    // where the grounding contract actually executes: the model cannot state a
    // fact about Greg without one of these round-trips succeeding.
    case "response.function_call_arguments.done":
      handleToolCall(evt);
      break;

    // Stage 1 task 1.9: read real token usage and reconcile with SPEC 4.1.3.
    // Audio output is ~89% of cost, so cumulative audioOut is the number to
    // watch across a whole conversation.
    case "response.done": {
      const u = evt.response?.usage;
      if (u) {
        const audioOut = u.output_token_details?.audio_tokens || 0;
        const audioIn = u.input_token_details?.audio_tokens || 0;
        const cached = u.input_token_details?.cached_tokens || 0;

        state.usage.turns += 1;
        state.usage.audioOut += audioOut;
        state.usage.audioIn += audioIn;
        state.usage.cached += cached;
        state.usage.input += u.input_tokens || 0;
        state.usage.output += u.output_tokens || 0;

        // $/1M for gpt-realtime-2.1-mini.
        // NOTE: `cached_tokens` covers ALL cached input (the ~4.6k-token system
        // prompt plus prior audio), not just audio. An earlier version did
        // (audioIn - cached), which goes hugely negative once the prompt is
        // cached. Cached input is billed at its own cheap rate instead.
        const estCost = estimateCost(state.usage);

        console.log(
          `[ambassador] turn ${state.usage.turns} | audioOut ${audioOut} | ` +
          `cumulative: audioOut ${state.usage.audioOut}, cached ${state.usage.cached}, ` +
          `est $${estCost.toFixed(4)}`
        );
      }
      break;
    }

    case "error":
      console.error("[ambassador] realtime error:", evt.error);
      break;
  }
}

/* ------------------------------ teardown ------------------------------ */

function cleanup() {
  clearTimeout(state.timer);
  clearTimeout(state.warnTimer);
  state.timer = state.warnTimer = null;

  try { state.dc?.close(); } catch {}
  try { state.pc?.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
  try { state.pc?.close(); } catch {}
  try { state.micStream?.getTracks().forEach((t) => t.stop()); } catch {}

  if (state.audioEl) {
    state.audioEl.srcObject = null;
    state.audioEl = null;
  }
  state.pc = state.dc = state.micStream = null;
}

function endSession(reason) {
  if (state.status === "idle") return;

  if (state.usage.turns > 0) {
    const u = state.usage;
    const estCost = estimateCost(u);
    console.log(
      `[ambassador] SESSION TOTAL: ${u.turns} turns | audioOut ${u.audioOut} | ` +
      `audioIn ${u.audioIn} | cached ${u.cached} | uncachedIn ${Math.max(u.input - u.cached, 0)} | ` +
      `est $${estCost.toFixed(4)} ($${(estCost / u.turns).toFixed(4)}/turn)`
    );
    // Grounding audit trail: which KB chunks did this conversation actually
    // rely on? Every factual claim should trace to one of these.
    const cites = state.citations ? [...state.citations] : [];
    console.log(
      `[ambassador] GROUNDING: ${state.searches || 0} searches, ` +
      `${cites.length} distinct sources cited` +
      (cites.length ? `:\n  ${cites.join("\n  ")}` : "")
    );
  }
  state.usage = { turns: 0, audioIn: 0, audioOut: 0, cached: 0, input: 0, output: 0 };
  state.searches = 0;
  state.citations = null;

  cleanup();
  setStatus("idle", "Conversation ended", reason || "");
  setButton("Start conversation", false);
}

/* ------------------------------- wiring ------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  cacheEls();
  if (!els.startBtn) return;

  els.startBtn.addEventListener("click", (e) => {
    // In limited/offline state the button is a real mailto link, so let it work.
    if (els.startBtn.dataset.mode === "email") return;

    e.preventDefault();
    if (state.status === "live" || state.status === "connecting") {
      endSession("You ended the conversation.");
    } else {
      startSession();
    }
  });

  // A forgotten tab is the most likely way to leak spend. pagehide fires on
  // navigation, tab close, and mobile backgrounding, where unload does not.
  window.addEventListener("pagehide", () => cleanup());
});
