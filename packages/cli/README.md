# context-hierarchy (`ctxh`)

`ctxh` is a small coding-harness CLI for
[context-hierarchy](https://github.com/iWebbIO/context-hierarchy): ask
questions through a hard per-model-call token cap — in-process — or serve the
capped OpenAI-compatible proxy any existing client can point at.

Oversized requests are never sent over the cap: they are decomposed by the
fleet engine (planner → workers → synthesizer, every sub-call itself capped),
with a distillate cache, durable spill records, and graceful degradation to a
truncation-fit single call. See the repo `docs/` for the design.

## Install

Published package (post-publish):

```sh
npm i -g context-hierarchy
```

From a checkout of this repo (for now):

```sh
git clone https://github.com/iWebbIO/context-hierarchy
cd context-hierarchy
npm install
npm run build
node packages/cli/dist/run.js --help
```

## Usage

```sh
ctxh serve [--port N]            # start the capped OpenAI-compatible proxy
ctxh ask "<question>" [--cap N] [--model M] [--stats]
                                 # one question through the in-process capped engine
ctxh config                      # effective config (API key masked, host only)
```

Configuration comes from the environment and a `.env` file in the working
directory (`UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, `UPSTREAM_MODEL`,
`CAP_TOKENS`, `STRATEGY`, `PORT`, `DATA_DIR`). The API key is never printed or
logged.

Full reference: [`docs/cli.md`](https://github.com/iWebbIO/context-hierarchy/blob/main/docs/cli.md).

## License

MIT — see [LICENSE](./LICENSE).
