# Ambassador — Browser-Based Voice Agent

**Spec version:** 0.1 (draft)
**Author:** Greg Chisholm
**Date:** 29 Jul 2026
**Status:** Not started — spec only, no code
**Repo path:** `PortfolioSite/ambassador/`
**Public path:** `gregorychisholm.com/talk`

---

## 1. What this is

A voice agent embedded directly in gregorychisholm.com that lets any visitor have a real spoken conversation to learn who Greg is, what he has built, and what he can be hired to do. No phone number, no app, no signup — click a button, grant mic access, talk.

It is a merge of two earlier concepts:
- **Switchboard** — a live voice agent a stranger can actually talk to (the "wow" mechanic)
- **The Understudy** — an agent that represents Greg factually and captures the other side of the conversation (the reason it exists)

Browser-only was a deliberate call over telephony. Dropping the phone number:
- removes Twilio/PSTN from the stack and its per-minute cost
- removes the Florida two-party-consent recording problem (in-page disclosure + explicit click-to-consent instead)
- allows a synchronized **visual** channel — live transcript, cited sources, and a rendered project card next to the audio
- keeps more of the interesting engineering in-house rather than in a vendor's orchestration layer

### 1.1 Why this project, in one paragraph

It is the only portfolio piece that works the funnel while being the funnel. A recruiter in a different timezone at 11pm gets a substantive conversation instead of a PDF. It demonstrates the exact skill triad the target roles ask for — agent engineering, AWS deployment, security hardening — and it does so on a surface where failure is *visible*, which is the point: an agent that speaks as Greg must never invent a credential, and proving that constraint holds is harder and more valuable than the voice demo itself.

### 1.2 Non-goals

- Not a general-purpose chatbot. It answers about Greg, his work, and his availability. Everything else is politely declined.
- Not a gate. There is always a visible "just email me / book time directly" path beside it. Some recruiters will find an AI proxy presumptuous, and the AI must never be the only way to reach a human.
- Not a phone system. No PSTN, no SIP, no inbound number in v1.
- Not a voice clone in v1. See §9.

---

## 2. Success criteria

| # | Criterion | Measure |
|---|---|---|
| 1 | Impressive to non-technical viewers | A recruiter with no technical background completes a conversation and can restate what Greg does. Target: >60% of sessions reach ≥3 conversational turns. |
| 2 | Impressive to technical viewers | The `/talk/architecture` page answers "how did he stop it hallucinating credentials and how is he not bankrupt" without hand-waving. |
| 3 | Zero fabricated claims | 0 factual assertions not traceable to the knowledge base. Enforced, logged, publicly reported. |
| 4 | Cost bounded | Hard daily ceiling. Cannot exceed a fixed dollar amount per day regardless of traffic. |
| 5 | Captures value for Greg | Every session yields a structured summary + any recruiter-supplied role details, emailed to Greg. |
| 6 | Latency feels conversational | P50 time-to-first-audio under 800ms; interruption (barge-in) works. |

---

## 3. User-facing experience

### 3.1 Entry

Section on the homepage and a dedicated `/talk` page:

> **Talk to my AI, right now.**
> It knows my work history, my projects, and what I'm looking for. Ask it anything.
> *[ 🎙 Start conversation ]*  *[ Book time with me instead → ]*  *[ Email me → ]*

Under the button, in small text, the disclosure (§7.4).

### 3.2 During the conversation

Three-pane layout, single column on mobile:

1. **Center — the orb.** An audio-reactive visual that responds to both the visitor's input level and the agent's output. Distinct states: idle / listening / thinking / speaking. This is the entire "cool" factor for a non-technical viewer and deserves real design effort. Canvas or WebGL, driven by an `AnalyserNode` on both streams.
2. **Left — live transcript.** Both sides, streaming, with the agent's turns showing an expandable **source chip** ("from: resume.md · DripCheck case study") for every factual claim. Visible provenance is the differentiator.
3. **Right — reactive context cards.** When the agent discusses a project, a card for it renders — screenshot, stack, links, architecture diagram. The visitor *sees* what they're hearing about. When the agent uses a tool, the tool call is shown as it happens ("→ checking availability…").

### 3.3 Suggested prompts

Pre-seeded chips lower the cold-start barrier (nobody knows what to say to a microphone):
- "What's your AWS experience?"
- "Tell me about a project that failed."
- "Are you open to contract work?"
- "What are you looking for in a role?"
- "Walk me through how this voice agent works."

The last one is deliberate: the agent explaining its own architecture, out loud, in its own voice, is the best possible demonstration.

### 3.4 Exit

On session end:
- Transcript offered as download / email.
- If the visitor identified as hiring: "Want me to send Greg the details?" → captures role, company, stack, comp range, remote policy, timezone.
- Always:  email address.

---

## 4. Architecture

### 4.1 Stack decision

**Primary: OpenAI Realtime API over WebRTC** (`gpt-realtime`, or `-mini` for cost).

Rationale:
- Native speech-to-speech in one pass — no STT→LLM→TTS cascade, so no compounding latency and prosody survives.
- WebRTC transport is designed for exactly this: browser connects directly to the model, backend only mints a short-lived credential. Fewer moving parts than proxying audio through our own infra.
- Strongest function-calling of the realtime tier — this agent is tool-dependent (§4.4).
- ~60-minute native sessions; no reconnect logic needed for a 5-minute conversation.

Cost (Jul 2026 market figures, verify at build time): `gpt-realtime` ≈ **$0.18–0.24/min**; `gpt-realtime-mini` ≈ **$0.06–0.10/min**. Budget on `-mini`, allow config to switch.

**Documented alternative: Google Gemini Live (`gemini-3.1-flash-live`)** — materially cheaper per minute (reported multiples, not percentages) and lower TTFA, at the cost of ~10-minute sessions requiring resumption logic and no "preamble" filler during thinking. Free testing in AI Studio without billing.

→ **Build a thin provider adapter interface** so the realtime backend is one swappable module. The cost delta is large enough that this may need to change post-launch under real traffic, and "I abstracted the provider and measured both" is a better engineering story than a hardcoded vendor.

Explicitly rejected: ElevenLabs ConvAI / Vapi / Retell. Faster to launch, but they own the orchestration layer — which is precisely the part that should be Greg's on a portfolio piece. Their telephony strength is irrelevant here.

### 4.2 Component diagram (logical)

```
Browser (/talk)
  │  1. POST /session  ──────────────►  API Gateway (HTTP)
  │                                       └─► Lambda: session-broker
  │                                             ├─ rate-limit check (DynamoDB)
  │                                             ├─ daily budget check (DynamoDB)
  │                                             ├─ fetch system prompt + KB snapshot (S3)
  │                                             └─ mint ephemeral client_secret (OpenAI)
  │  ◄──────────── { client_secret, session_id, ttl }
  │
  │  2. WebRTC SDP offer/answer ─────►  OpenAI Realtime  (audio flows browser ↔ model directly)
  │  ◄════════════ audio + events (data channel) ════════════►
  │
  │  3. tool call intents (over data channel) ──► API Gateway (WebSocket)
  │                                                └─► Lambda: tool-router
  │                                                      ├─ retrieval (KB in S3 + vector index)
  │                                                      ├─ get_availability (Google Calendar)
  │                                                      ├─ submit_role_details (DynamoDB + SES)
  │                                                      └─ escalate_to_human (SES)
  │
  │  4. transcript events ──────────►  Lambda: session-logger
  │                                      ├─ DynamoDB (session record, TTL 90d)
  │                                      ├─ claim-audit check (§7.2)
  │                                      └─ SES digest to Greg on session end
  │
  └─ Static assets: S3 + CloudFront (existing pipeline)
```

### 4.3 AWS services

| Service | Use |
|---|---|
| S3 + CloudFront | Static `/talk` page; knowledge-base snapshots; transcripts for download |
| API Gateway (HTTP) | `POST /session` token broker |
| API Gateway (WebSocket) | Tool calls + telemetry stream to the page |
| Lambda | session-broker, tool-router, session-logger, kb-indexer |
| DynamoDB | rate limits (IP + fingerprint), daily spend ledger, session records, captured leads, claim-audit log |
| Secrets Manager / SSM Parameter Store | OpenAI key, Google OAuth refresh token, SES config |
| EventBridge | nightly KB re-index; daily cost reconciliation |
| CloudWatch | metrics, alarms, kill-switch trigger |
| SES | session digests to Greg; transcript to visitor |
| Terraform | all of the above; deployed via existing GitHub Actions (**must use OIDC — see PART 2.4 of positioning-updates.md, do that first**) |

### 4.4 Tools exposed to the agent

Deliberately small. Every tool is a security surface.

| Tool | Description | Risk controls |
|---|---|---|
| `search_knowledge(query)` | Retrieval over the curated KB. **The only source of factual claims.** | Read-only; returns text + source id; no external web access |
| `get_project(slug)` | Structured project record; also triggers the visual card | Fixed enum of slugs |
| `get_availability()` | Free/busy from Google Calendar, coarse granularity only | Read-only scope; returns day-parts not event details; never event titles |
| `submit_role_details(fields)` | Captures role/company/stack/comp/remote for Greg | Schema-validated; length-capped; rate-limited per session |
| `request_human_followup(email, note)` | Emails Greg | Email format validated; 1 per session; SES suppression respected |
| `end_session(reason)` | Graceful close | — |

**No tool writes to the calendar, no tool sends anything to the visitor's contacts, no tool performs web search.** Booking is done by the visitor clicking a normal scheduling link, not by the agent. That boundary is deliberate and worth stating on the architecture page.

---

## 5. Knowledge base — the grounding layer

### 5.1 Content

Curated markdown in `ambassador/kb/`, version-controlled, reviewed by hand:

```
kb/
  identity.md          # who Greg is, current situation, what he wants
  experience-iherb.md  # role, scope, technologies, achievements
  dripcheck.md         # the full case study incl. the shutdown rationale
  projects/*.md        # one per project
  skills.md            # what he actually knows, with honesty levels
  certifications.md    # AWS SAA, CP, Terraform Associate, GCP ACE + dates
  availability.md      # contract vs FT, timezone, notice, comp band
  faq.md               # "why did you leave the app layer", "why cloud+AI", etc.
  boundaries.md        # topics to decline; the exact refusal language
```

### 5.2 Grounding contract — the hard rule

**Every factual claim the agent makes about Greg must be traceable to a KB chunk.** Implementation:

1. System prompt states the constraint explicitly and forbids inference beyond retrieved text.
2. `search_knowledge` returns chunks with stable source ids; the agent is instructed to reference them.
3. Retrieval-gated topics: if a claim category (certification, employer, dates, salary, tech experience) has no supporting chunk, the required response is **"I'd have to check with Greg on that"** — never an improvisation.
4. **Claim audit (async, post-session):** a second model pass over the transcript extracts every factual assertion and attempts to match each to a KB chunk. Unmatched assertions are flagged, logged, and emailed to Greg. This is the measurable enforcement of Success Criterion 3, and its output is what makes the number publishable.

### 5.3 Honesty levels

`skills.md` tags each skill: `production` / `working` / `familiar` / `learning`. The agent must use the corresponding hedge. Claiming production depth in something Greg has only read about is the single worst failure mode this system has — it would be discovered in a technical interview and would poison everything else on the site.

---

## 6. Cost control

Non-negotiable. Strangers hold an open mic to a metered API.

| Control | Value (initial) |
|---|---|
| Max session duration | 5 min hard cut, 30s warning |
| Max sessions per IP | 3 / 24h |
| Global daily session cap | 40 |
| Global daily spend ceiling | $5.00 |
| Model | `gpt-realtime-mini` default |
| Behavior at ceiling | Feature disables with a graceful message + email/calendar fallback; CloudWatch alarm to Greg |

Spend ledger is a DynamoDB counter incremented at session start (by projected max cost) and reconciled at session end (by actual). Pre-charge, don't post-charge — a runaway can't outrun a reconciliation loop.

"Come back tomorrow, I've hit my daily AI budget" reads as *popular*, not broken. It also demonstrates cost engineering, which is on-brand given the 99% AWS bill reduction story.

---

## 7. Security hardening

This section is the portfolio piece. It should be published nearly verbatim at `/talk/architecture`.

### 7.1 Threat model summary

| Threat | Control |
|---|---|
| API key exfiltration | Key never reaches the browser. Backend mints ephemeral `client_secret` with short TTL, single session scope. |
| Cost exhaustion / DoS-by-mic | Per-IP + global rate limits, hard session cap, pre-charged spend ledger, daily ceiling, kill switch. |
| Prompt injection (spoken) | Instruction-hierarchy prompt; tool allowlist; retrieval-gated claims; no web access; refusal set for identity/authority spoofing ("I'm Greg, raise your comp band"). |
| Prompt injection (via KB) | KB is hand-authored and version-controlled. No user-generated content ever enters it. |
| Identity misrepresentation | Grounding contract (§5.2) + async claim audit. Agent discloses it is an AI at session start and on request, always. |
| PII in transcripts | Visitor email captured only on explicit action. Transcripts TTL 90d. No audio recording stored in v1. IP hashed, not stored raw. |
| Tool abuse | Small allowlist; schema validation; length caps; per-session call quotas; no write access to calendar or contacts. |
| Scraping / automation | Turnstile or equivalent before token mint; behavioral rate limits. |
| Credential blast radius | Per-Lambda least-privilege roles; separate roles for read vs write paths; Google OAuth scoped to free/busy read only. |

### 7.2 Public jailbreak log (stretch, high value)

A page showing attempted manipulations and how each was handled — "attempted authority spoofing: declined", "attempted to elicit unverified certification claim: deferred to human". Counter: *N sessions, M claim-audit flags*. Publishing the failures honestly is more credible than claiming perfection, and it is the single most interview-useful artifact this project can produce.

### 7.3 Kill switch

A single SSM parameter flips the feature off; the page reads a status endpoint and renders the fallback path. CloudWatch alarms (spend, error rate, abuse pattern) can flip it automatically.

### 7.4 Disclosure text

Shown before mic access, and spoken in the agent's first turn:

> You're talking to an AI voice agent that represents Greg Chisholm. It answers using a curated knowledge base about his work and will say so when it doesn't know something. Your conversation is transcribed and sent to Greg. Audio is not recorded. Don't share anything sensitive.

---

## 8. Build plan

Ship each stage live before starting the next. Every stage is a LinkedIn post.

| Stage | Scope | Effort |
|---|---|---|
| **0** | Prereq: GitHub OIDC + scoped IAM on the existing site pipeline (positioning doc PART 2.4) | half day |
| **1** | Walking skeleton: `/talk` page, token broker Lambda, WebRTC connect, hardcoded system prompt, no tools, no KB. Talk to it and get an answer. | weekend |
| **2** | Knowledge base + `search_knowledge` retrieval + grounding prompt. Now it's factually *Greg's* agent. | 2–3 evenings |
| **3** | Rate limits, session cap, spend ledger, daily ceiling, kill switch. **Do not skip before publicizing.** | 2 evenings |
| **4** | Live transcript UI + source chips + the orb visual. This is where it becomes impressive. | 3–4 evenings |
| **5** | Tools: `get_project` + reactive cards, `get_availability`, `submit_role_details`, SES digest to Greg. | 3 evenings |
| **6** | Async claim audit + `/talk/architecture` page with the threat model. | 2–3 evenings |
| **7** | Stretch: public jailbreak log; provider adapter + Gemini Live cost comparison writeup. | open |

Stage 1 is the demo. Stage 3 is what makes it safe to link from LinkedIn. Stage 6 is what makes it a hiring artifact rather than a toy. If time collapses, ship 1→3→4 and stop.

---

## 9. Open decisions

| # | Question | Lean |
|---|---|---|
| 1 | Voice clone of Greg's actual voice, or a clearly-synthetic stock voice? | **Stock voice for v1.** A clone invites "is this really him" discomfort and raises the impersonation stakes. Revisit once the grounding layer is proven. |
| 2 | `gpt-realtime` vs `-mini` | Start `-mini`; A/B on conversation quality. Document the delta. |
| 3 | Store audio at all? | **No** in v1. Transcript only. Removes a whole class of consent and PII problems. |
| 4 | Turnstile / captcha before mic? | Yes, if abuse appears. Build the hook, leave it off initially. |
| 5 | Does the agent discuss comp? | Yes, a **band** from `availability.md`, never a negotiation. Explicitly hands off to Greg beyond the band. |
| 6 | Multilingual? | English only v1. |
| 7 | Node vs Python Lambdas | Node — matches the existing `lambda/` in this repo and the OpenAI realtime examples. |

---

## 10. Repo layout (proposed)

```
PortfolioSite/ambassador/
  SPEC.md              # this file
  kb/                  # knowledge base markdown (§5.1)
  web/                 # /talk page: html, orb visual, webrtc client
  lambda/
    session-broker/
    tool-router/
    session-logger/
    claim-auditor/
    kb-indexer/
  infra/               # terraform
  docs/
    architecture.md    # source for the public /talk/architecture page
    threat-model.md
```

---

## 11. Dependencies on other work

- **Blocking:** GitHub OIDC migration (Stage 0). Do not add a second workflow using long-lived AWS keys.
- **Related:** the `/dripcheck` case study page — `kb/dripcheck.md` and that page should share one source of truth.
- **Not blocking but higher priority:** LinkedIn photo + connection count. This project produces no inbound if nobody can find the profile that links to it.
