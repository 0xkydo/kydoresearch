# mock-challenge

Toy AutoResearch fixture. Minimize `f(x, y) = (x-3)^2 + (y+1)^2` by editing
`src/solution/params.json` (the only editable path). Lower score is better.

## Commands

- Setup (install deps): `./setup.sh`
- Correctness check: `./verify.sh` — validates params.json schema and bounds (|x|,|y| <= 10, `algorithm` string required)
- Benchmark: `./benchmark.sh` — runs verify, then writes `score.json`
- Submit: `bin/mockchal submit --note-file <note.md>` (notes are required and public)
- Leaderboard: `bin/mockchal submissions --all`
- Sync to best: `bin/mockchal sync`

Note: the correctness check (`verify.sh`) and the performance benchmark
(`benchmark.sh`) are different commands, like mlxfast. The benchmark also
embeds the correctness check, like ecdsafail.
