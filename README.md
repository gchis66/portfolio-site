# gregorychisholm.com

Source for my site, including a **voice agent you can talk to in the browser**: [gregorychisholm.com/talk](https://gregorychisholm.com/talk). It answers questions about my work from a hand-written knowledge base and refuses to make things up.

Full write-up with the threat model: [gregorychisholm.com/talk/architecture](https://gregorychisholm.com/talk/architecture)

## The problem

A voice agent on a public website means strangers on the internet hold an open microphone to a metered API. It also means an agent that could cheerfully invent credentials I don't have. Both had to be impossible by design, not by prompt.

## How it works

```
Browser ──POST /session──► API Gateway ─► Lambda: session-broker
                                         ├─ kill switch (SSM)
                                         ├─ per-visitor limit (DynamoDB)
                                         ├─ daily cap, spend pre-charged (DynamoDB)
                                         ├─ API key (SSM SecureString, never sent to the browser)
                                         └─ brokers the WebRTC offer to the Realtime API
Browser ◄════ audio, peer to peer with the model (never touches my servers) ════►
Browser ──POST /kb-search──► API Gateway ─► Lambda: kb-search
                                           ├─ embeds the query
                                           └─ cosine search over a 109-chunk index in S3
```

The model's tool calls arrive in the browser, not on my backend, because audio is peer to peer. So knowledge-base search is its own small Lambda with its own rate limit. The browser can't hold the embedding key or download the index.

## Decisions worth knowing

- **Speech to speech, one model.** No speech-to-text, LLM, text-to-speech chain. One pass means no stacked latency, and tone survives.
- **Budget is pre-charged, not reconciled.** Audio never passes through my infrastructure, so there is nothing to meter at the source. Each session is charged a pessimistic estimate up front; at the daily ceiling the feature turns itself off and offers email instead.
- **Grounded or silent.** Factual answers must come from the knowledge base. With no matching source, the agent says it doesn't know. Retrieval quality is measured against a 49-case eval set.
- **Small tool surface.** One tool, no web access. Fewer tools means fewer ways for a spoken prompt injection to do damage.

## Cost

Measured on a real 14-turn conversation: about 8 cents, roughly half a cent per turn. Spoken output is about 60% of the cost, which is why answers are kept to two or three sentences.

## Deploy pipeline

GitHub Actions deploys on push to `main` with **OIDC federation**, no stored AWS keys. The trust policy is pinned to this repo and branch, and the role can do four things to three named resources. The site went from an F to an A on securityheaders.com with a hand-tuned CSP, HSTS and Permissions-Policy.

## Layout

| Path | What |
|---|---|
| `prod/` | Static site, synced to S3 and served by CloudFront |
| `prod/talk/` | Voice agent front end |
| `ambassador/lambda/session-broker/` | Session setup, limits, spend ledger |
| `ambassador/lambda/kb-search/` | Knowledge-base search for the agent's tool calls |
| `lambda/` | Visitor counter API |
| `.github/workflows/` | OIDC deploy |

Stack: JavaScript, AWS Lambda, API Gateway, DynamoDB, S3, CloudFront, SSM Parameter Store, OpenAI Realtime API (WebRTC), GitHub Actions.
