# Latency Lab

Tune a toy request pipeline by editing only `solution/config.json`. Lower
latency is better.

This scenario demonstrates verifier exhaustion, a valid regression, a repaired
retry, sibling selection, local submission, a plateau, church reflection, and
a final improvement. With `max loops: 6`, the key moments are:

- loop 1: one invalid candidate and one slower candidate;
- loop 2: a retry is repaired and the best of two improvements is submitted;
- loops 3–5: dry baseline replays trigger church;
- loop 6: the refocused experiment improves and submits again.

Prepare this template through `../prepare.sh`; see the collection README for
the Pi walkthrough.

## Commands

```bash
./setup.sh
./verify.sh
./benchmark.sh
./bin/mockchal submissions --all
```

The mock challenge CLI persists only to `.mockchal/` and makes no network
calls.
