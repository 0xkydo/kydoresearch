# Ranking Quality

Tune three ranking-signal weights by editing only `solution/weights.json`.
Higher quality is better, so this example makes the dashboard and finalist
selection exercise the `+` score direction.

With `max loops: 6`, the deterministic arc includes an invalid weight vector,
a quality regression, a repaired retry, two improving siblings, a promoted
local submission, a dry plateau, church reflection, and a final score of `1`.

Prepare this template through `../prepare.sh`; see the collection README for
the Pi walkthrough.

## Commands

```bash
./setup.sh
./verify.sh
./benchmark.sh
./bin/mockchal submissions --all
```

Everything is local. The seeded “leaderboard” is JSON fixture data, not a
service.
