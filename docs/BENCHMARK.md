# Large-file I/O benchmark

This opt-in benchmark isolates Core startup, provenance hashing and independent checking. Its input is freshly generated random bytes, **not scientific data**. It makes **zero model calls** and does not measure model latency, reasoning quality or human usability.

```sh
npm run build:core
node scripts/benchmark-large.mjs --run
```

Defaults are 512 MiB and 1024 MiB, under a new .artifacts/large-file-benchmark/<timestamp> directory. --sizes-mib, --output and --python override those settings. Without --run the script only prints help. It retains the generated files; default source allocation is at least 1.5 GiB. Never add them to a release package or git commit.

Each input is fully written with fresh cryptographic random chunks and fsynced. The script verifies exact stat size and allocated blocks >= logical bytes, rejecting sparse placeholders. It records writer-computed SHA256, then createRunStore freezes/hashes the selected input. A small claimed-digest artifact is independently checked by the generated stdlib Python command `python3 tools/check-input.py`, which streams every input byte and compares SHA256/byte count. Initial checking runs under the project lock; public checkRun measures recheck. A model object throws if an inference method is accidentally called.

## Observed run

On 2026-10-16, both sizes passed initial check and recheck on Core 0.1.0-rc.3, AI SDK 7.0.142, Node 22.22.0, Python 3.11.4 and Linux 6.8.0-111-generic x64. Files were on the shared NFS filesystem. The retained report is `.artifacts/large-file-benchmark/2026-10-16T14-22-34-272Z/results.json`.

| Source size | Logical bytes | Allocated bytes | createAgent | Run creation/provenance | Initial check | Recheck |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 512 MiB | 536,870,912 | 537,853,952 | 0.163 s | 2.927 s | 4.384 s | 4.247 s |
| 1 GiB | 1,073,741,824 | 1,134,497,792 | 0.011 s | 3.053 s | 8.700 s | 8.361 s |

Full generation/fsync took 4.769 s and 9.958 s, separately from these lifecycle phases. Each baseline hashed its exact full input size. The Python checker independently read 536,870,912 or 1,073,741,824 bytes on each initial check and recheck. The report also includes observed Linux process I/O deltas, checker counters, RSS at phase end, filesystem allocation, hardware and versions.

The inputs were generated immediately beforehand; no cache was dropped. The output in this benchmark is a small digest claim; multi-GiB artifact hashing is not measured. The first createAgent call also includes first-use initialization effects, while the second reuses the process. Linux rchar includes metadata/other reads and reaped-child accounting; read_bytes does not establish physical NFS/cache-miss throughput. End-of-phase RSS is not peak memory. These are one machine's cache-sensitive observations, not a throughput guarantee, cold-disk benchmark, scaling law or comparison with a live inference service.
