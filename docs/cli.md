# ctxh — the context-hierarchy CLI

`ctxh` is the coding-harness front door for `context-hierarchy`: a small CLI
that runs questions through the capped engine **in-process** (`ask`) and boots
the OpenAI-compatible **proxy** (`serve`). Same core, same config, same
guarantee: no model call ever leaves over the token cap.

## Install

From a checkout of this repo (for now — the npm package is not published yet):

```sh
git clone https://github.com/iWebbIO/context-hierarchy
cd context-hierarchy
npm install
npm run build
node packages/cli/dist/run.js help
```

Once the package is published to npm:

```sh
npm i -g context-hierarchy
ctxh help
```

## Configuration

Every command reads the same configuration, from the environment and a
`.env` file in the working directory (environment wins; `loadConfig` from
`@context-hierarchy/proxy` does the parsing):

| Variable | Meaning | Default |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | OpenAI-compatible base URL (version segment included) | required |
| `UPSTREAM_API_KEY` | key forwarded to the upstream — never printed or logged | required |
| `UPSTREAM_MODEL` | model every call is routed to | required |
| `CAP_TOKENS` | hard per-model-call token cap (prompt side) | `6000` |
| `STRATEGY` | `hierarchy` (default) or `truncation` | `hierarchy` |
| `CONCURRENCY` | max concurrent fleet sub-calls per request | `3` |
| `PORT` | proxy listen port (`0` = ephemeral) | `8787` |
| `DATA_DIR` | calibration / spill / distillate / telemetry state | `.ctxh` |
| `PROXY_API_KEY` | when set, clients must present this bearer token to the proxy | (empty) |

## Commands

### `ctxh serve [--port N]`

Boots the proxy (`startProxy`) with the config above; `--port` overrides
`PORT` for this run. One startup line is logged — port and upstream **host**
only; the API key and any URL that could carry credentials are never printed.
`Ctrl-C` closes the server cleanly.

```sh
$ ctxh serve --port 8787
ctxh serve: proxy listening on http://127.0.0.1:8787 (upstream host: api.example.com, model: glm-5.3-max, cap: 6000 tokens, strategy: hierarchy)
```

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1`.

### `ctxh ask "<question>" [--cap N] [--model M] [--stats]`

One-shot: loads the config, builds the in-process stack —
`ProviderAdapter` → `TokenAccountant` → strategy (`hierarchy` or `truncation`,
from `STRATEGY`) → `FleetEngine` under the cap (`--cap` overrides
`CAP_TOKENS`, `--model` overrides `UPSTREAM_MODEL`) — runs the question as a
single user message, and prints the answer to stdout.

- `--stats` appends a compact sub-call summary (per-call label, tokens,
  latency; from the engine's `onSubCall` collector) — what the cap actually
  spent, per call:

  ```sh
  $ ctxh ask "Explain the fleet pipeline" --cap 4000 --stats
  <the answer>
  sub-calls: 3
    1. planner  tokens 512t est / 540+68t actual  latency 812ms
    2. worker  tokens 3180t est / 3301+190t actual  latency 2210ms
    3. reducer  tokens 2266t est / 2259+140t actual  latency 1490ms
    4. synthesizer  tokens 2890t est / 2931+204t actual  latency 1510ms
  ```

- A degraded answer (the fleet failed; one truncation-fit capped call
  answered) is noted on **stderr**, so piping the stdout answer stays clean.
- An upstream error exits non-zero (`1`) with the upstream's message on
  stderr.

### `ctxh config`

Prints the **effective** configuration: the upstream **host** only, the API
key masked as `set` / `unset` (the key value is never printed), and the
resolved data dir path — plus cap, strategy, port, and model.

```sh
$ ctxh config
upstream host: api.example.com
upstream model: glm-5.3-max
upstream api key: set
proxy api key: unset
cap: 6000 tokens
strategy: hierarchy
port: 8787
data dir: /path/to/cwd/.ctxh
```

### `ctxh help` (or no args)

Short usage text. Exit codes: `0` ok, `1` runtime/upstream error, `2` usage
error (unknown flag/command prints the usage text).

## Flags

| Flag | Command | Meaning |
| --- | --- | --- |
| `--port N` | serve | override `PORT` for this run (`--port=8788` also works) |
| `--cap N` | ask | override `CAP_TOKENS` for this question |
| `--model M` | ask | override `UPSTREAM_MODEL` for this question |
| `--stats` | ask | print the sub-call summary after the answer |

Flags may appear anywhere on the line; an unknown flag prints usage and
exits `2`.

## How `ask` relates to `serve`

Two front doors over the same core:

- **`ask`** builds the engine **in-process** — `ProviderAdapter →
  TokenAccountant → strategy → FleetEngine` — and runs one question through
  it. No server, no HTTP: the process starts, asks, prints, exits. Same
  config, same cap semantics, same data dir (calibration factors, spill
  records, distillates) as the proxy.
- **`serve`** boots the HTTP front door (`startProxy`): any OpenAI-compatible
  client — SDKs, editors, agents — points its base URL at it and gets the
  same capped engine behind the OpenAI wire contract, streaming included.

Both read the same `.env` / environment, enforce the same
per-model-call cap, and degrade the same way (a fleet failure falls back to
one truncation-fit capped call, marked degraded).

## Security notes

- The upstream API key lives in `.env` (git-ignored) or the environment. It
  is forwarded to the upstream and nothing else: never printed, never logged,
  never embedded — `ctxh config` shows only `set` / `unset`.
- `ask` output is the model's answer; diagnostics (degraded marker) go to
  stderr so piping stdout is safe.
