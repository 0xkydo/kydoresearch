# Task: improve ranking quality

The toy ranker blends three normalized signals:

- `semanticWeight`: query/document semantic similarity;
- `freshnessWeight`: preference for newer material;
- `diversityWeight`: penalty against near-duplicate results.

Edit `solution/weights.json`. All weights must be finite values in `[0, 1]`
and sum to exactly `1` within floating-point tolerance. `strategy` names the
experiment. The benchmark produces a deterministic quality score, and higher
is better.

Only `solution/` is editable.
