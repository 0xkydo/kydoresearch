# Memory Packer

Reduce a toy inference pipeline’s peak memory by editing only
`solution/layout.json`. Lower memory is better.

This challenge uses discrete choices—power-of-two tile sizes, precision, and
buffer reuse—rather than continuous coordinates. The six-loop mock arc covers
an invalid layout, a non-improving extreme, a repaired retry, competing valid
improvements, local submission, a dry plateau, church reflection, and a final
memory reduction.

Prepare this template through `../prepare.sh`; see the collection README for
the Pi walkthrough.

## Commands

```bash
./setup.sh
./verify.sh
./benchmark.sh
./bin/mockchal submissions --all
```

No model provider or remote challenge service is used.
