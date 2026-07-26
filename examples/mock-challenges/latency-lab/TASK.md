# Task: reduce request latency

The service has three tunable execution levers:

- `batchSize`: requests grouped per worker dispatch;
- `cacheEntries`: hot objects retained in a tiny local cache;
- `prefetch`: whether the next object is fetched ahead of demand.

Edit `solution/config.json` and minimize the deterministic latency score.
`strategy` is a required public label for the approach.

Only `solution/` is editable. Correctness and performance are separate gates,
and only a meaningful improvement over the current local best is submitted.
