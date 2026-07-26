# Task: reduce peak memory

The toy inference runtime exposes three layout choices:

- `tileSize`: a power of two from 8 through 128;
- `precision`: either `fp32` or `fp16`;
- `reuseBuffers`: whether compatible intermediate buffers share storage.

Edit `solution/layout.json` and minimize peak memory in MiB. `allocator` is a
required label describing the layout family.

Only `solution/` is editable. The verifier enforces layout compatibility before
the benchmark may produce a score.
