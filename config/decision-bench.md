# Decision-model bench

Generated 2026-10-02T23:00:45.491Z by `npm run bench:decisions`. Elections: the real Prime Coordinator ballot for 8 constituencies among equal candidates. Verdicts: 20 labelled changes, half with one concrete defect. "Fast path" is an approval whose p(approve) clears the floor and so stands without a written review; a defective change on the fast path ships unreviewed. The safe floor is the lowest with none.

| model | abstained | accuracy | Brier | safe floor | cost | latency med | errors |
|---|---|---|---|---|---|---|---|
| `upstage/solar-decide` | 0/8 | 90% | 0.074 | 0.6 | $0.00073 | 0.8s | 0 |
| `typesafe/jev-1.13` | 0/8 | 85% | 0.115 | 0.6 | $0.00062 | 0.3s | 0 |

## `upstage/solar-decide` fast path by floor

| floor | sound approved unexplained | defective approved unexplained |
|---|---|---|
| 0.6 | 8/10 | 0/10 |
| 0.7 | 7/10 | 0/10 |
| 0.8 | 7/10 | 0/10 |
| 0.85 | 7/10 | 0/10 |
| 0.9 | 5/10 | 0/10 |
| 0.95 | 4/10 | 0/10 |

## `typesafe/jev-1.13` fast path by floor

| floor | sound approved unexplained | defective approved unexplained |
|---|---|---|
| 0.6 | 6/10 | 0/10 |
| 0.7 | 4/10 | 0/10 |
| 0.8 | 3/10 | 0/10 |
| 0.85 | 3/10 | 0/10 |
| 0.9 | 2/10 | 0/10 |
| 0.95 | 1/10 | 0/10 |
