# Neuro-Cognitive Go

Base Go only — no cards, no variant rules. The goal is to port the cognitive layer that produced the
Clockwork Court's measured chess rating (`STOCKFISH-*-REPORT.md`) onto 9x9 Go and give it a benchmarked
rating of its own.

This directory is standalone: nothing here requires `src/` or the card game.

## Status

| Layer | State |
| --- | --- |
| Rules core (`go-core.js`) | Done — captures, suicide, simple ko, positional superko, Tromp-Taylor area scoring |
| Light playouts (`go-playout.js`) | Done — eye-avoiding random rollouts, ~2.5k playouts/sec on 9x9. Kept as the readable reference implementation |
| Fast board (`go-fastboard.js`) | Done — incremental chains, O(1) exact capture/atari tests |
| Fast playouts (`go-fastplayout.js`) | Done — same policy on the fast board, **12.8k playouts/sec (6.0x)** |
| GTP client (`gtp.js`) | Done — drives GNU Go 3.8 |
| Rating harness (`tools/gnugo-rating.cjs`) | Done — colour-alternating match play, same statistics as the chess harness |
| Baseline policies (`go-players.js`) | Done — `random` and `flat` (flat Monte Carlo) |
| Self-play harness (`tools/selfplay.cjs`) | Done — policy vs policy, colour-alternating |
| Pattern priors (`go-patterns.js`) | Done — hand-authored features, no training |
| Frames / plans (`go-cognitive.js`) | Done — seven competing plans with decaying support |
| Cognitive-PUCT (`go-mcts.js`) | Done — PUCT tree, rollout leaves, plan-conditioned priors |
| Tactical playouts + MC-RAVE | Done (Phase 1) |
| Regional matrix (`go-regions.js`) | Built and measured — **does not help; see below** |
| Eye layer (`go-eyes.js`) | Done — Benson unconditional life, graded eye reading, vital points |
| Ladder guard (`go-ladder.js`) | Done — exact ladder reader consulted by the priors; **-57% ladder blunders, 63% vs unguarded** |
| Scoring for human play (`go-score.js`) | Done — settle-then-score, audited against GNU Go |
| First-play urgency | Done — unvisited edges valued at the parent, not at zero |
| Pass gating (`passReady`) | Done — pass stays out of the tree until the board is developed |
| GTP engine (`engine.cjs`) | Done — plays in any Go GUI |
| SGF archive priors (`go-style.js`) | Done — five play-style personalities fitted from 6,672 human 9x9 records |
| Episodic advisor | Not started |

## Measured so far

All on 9x9, GNU Go 3.8, Tromp-Taylor scoring cross-checked against GNU Go's own `final_score`.

### Internal ladder

| Match | Result |
| --- | --- |
| `flat` (2000 playouts) vs `random`, 4 games | 4/4, +41.0 points average |
| `puct` (1200 sims) vs `flat` (1200 playouts), 2 games | **2/2, +81.0 points — the whole board, both games** |

### Even games vs GNU Go level 1

The target was a 50% score. It is met, and the run that establishes it is **200 games on a seed that no
tuning had seen**.

| Policy | Games | Score | 95% interval | Average margin |
| --- | ---: | ---: | :---: | ---: |
| `random` | 6 | 0/6 | — | -81.0 |
| `flat` (4000 playouts) | 6 | 0/6 | — | -81.0 |
| `puct` pre-Phase-1 (2000 sims) | 6 | 0/6 | — | -47.3 |
| `puct` Phase 1 (2000 sims) | 24 | 10/24 (41.7%) | 24.5-61.2% | -42.5 |
| `puct` fast playouts (2000 sims) | 40 | 16/40 (40.0%) | 26.3-55.4% | -46.2 |
| `puct` fast playouts (6000 sims) | 200 | 111/200 (55.5%) | 48.6-62.2% | -34.3 |
| **`puct` + eye layer (6000 sims)** | **200** | **114/200 (57.0%)** | **50.1-63.7%** | **-27.7** |

Two things did the work, and it is worth being precise about which.

**The engine got 6x faster, and the speed was spent on search.** `go-fastboard.js` keeps every chain as a
union-find set carrying the *pseudo-liberty triple* — the count `n`, sum `s` and sum of squares `q` of the
multiset of (stone, adjacent empty) pairs. Capture is then `n === 0`, and a chain has exactly one distinct
liberty iff `s*s === n*q`, by the equality condition of the Cauchy-Schwarz inequality; that liberty is
`s/n`. Both tests are O(1) and exact despite the multiplicities. Playouts went from 2.5k/sec to 12.8k/sec,
and at equal simulations strength is unchanged (40.0% vs the 41.7% baseline) — so the gain is purely that
the budget buys more search. The original baseline spent 8.9s per game at 2000 simulations; the current
engine spends 5.0s per game at 6000. Simulations are what converted: 2000 -> 40%, 6000 -> 55.5%.

The fast board was fuzzed against `go-core.js` before anything was built on it: 2.8M assertions across 400
random games covering legality, self-atari, atari points, liberty counts, chain sizes, eye detection, ko and
final score, with zero mismatches. `go-playout.js` is deliberately kept as the readable reference, and
`--fast-playouts false` still selects it, so the two can always be compared.

**The eye layer changed how the bot loses, more clearly than whether it wins.** See below.

### Why the losses were whole-board, and what the eye layer did about it

Breaking the 41.7% baseline down by margin showed the score was hiding the real problem:

| | n | Average margin | Average length |
| --- | ---: | ---: | ---: |
| Wins | 16 | +2.8 | 93 moves |
| Losses | 24 | **-77.6** | 133 moves |

22 of 24 losses were -88.5 or -73.5 — *the entire board*. Replaying them showed why: the bot played
plausible shape into the midgame and then never made two eyes, and GNU Go's aftermath phase harvested every
group. Nothing in `go-patterns.js` — capture, atari, contact, line, distance from the last move — knows what
an eye is, so nothing in the engine could see this coming.

`go-eyes.js` addresses it in two tiers. **Benson's algorithm** decides unconditional life *exactly*: a chain
is pass-alive when it can never be captured, however the opponent plays and even if its owner never answers
again. It is the only claim in the engine that cannot be wrong, which is what makes it safe to prune on.
Above it sits a **graded reading** for the rest of the game, which counts eyes by shape rather than size — a
square four has no dividing point and is one eye, a straight four splits and is worth more — and emits the
*specific points* that make or break them. Two new plans, `live` and `kill`, take their activation from the
share of stones in groups with neither two eyes nor room to make them.

Measured over the same 200 paired games (identical seeds and colours, so each game is a matched pair):

| | Control | With eye layer |
| --- | ---: | ---: |
| Score | 111/200 (55.5%) | 114/200 (57.0%) |
| **Whole-board losses (worse than -70)** | **85/200** | **61/200** |
| Narrow losses | 4/200 | 25/200 |
| Average margin | -34.3 | -27.7 |

The failure mode the layer was built for moved substantially: 24 games stopped being wipeouts. But the
honest reading of the *winrate* is that it is not established. A McNemar exact test on the 89 discordant
pairs gives 46-43 in the layer's favour, **p = 0.83** — indistinguishable from a coin flip. The margin gain
of +6.6 points has a 95% interval of [-0.7, +14.0], which contains zero.

An earlier 60-game A/B showed the layer at 68.3% against a 50.0% control, a +18.3 point gap. **That result
did not survive.** It was measured on the seed the layer had been developed against, and on 200 fresh games
the gap is +1.5 points. It is recorded here because it is exactly the shape of result that gets published by
mistake: a large effect, a plausible mechanism, and a sample too small to carry it.

So the layer's standing is: it demonstrably stops groups dying wholesale, it costs nothing measurable, and
it is left on. It has **not** been shown to win more games. What it revealed is that living was not
sufficient — the bot now loses close games instead of catastrophic ones, and the remaining gap is
positional and endgame accuracy rather than life and death. The win margins say the same thing: 109 of 114
wins are by under 5 points, with a median of +1.5.

### Two smaller changes

**Passing and endgame gating.** The first eye-layer benchmark exposed a separate failure: because `PASS` was
always a legal root edge, the search sometimes passed on its first move and then passed repeatedly while the
opponent occupied the board. The engine now keeps pass out of the tree until at least 55% of the board's
move/stone progress is reached, with one exact exception: if Benson says every remaining legal point is
settled, pass is admitted immediately. Settled points are pruned rather than merely down-weighted, so a
finished position collapses to the two-pass ending. A 16-game 2,000-simulation smoke run after this change
had zero engine passes in the first ten engine turns and all games ended by two passes. The 200-game results
above predate this gate and should not be presented as its strength measurement.

**First-play urgency.** An edge with no visits and no RAVE evidence was valued at 0 — an even game. In a
losing position that is optimistic about everything untried, so every unexplored move outranked the best
known one and the search spread itself across the board. Unvisited edges now take the parent node's own
value, less a reduction that grows with the explored prior mass. Carried at 0.2 in every run above; its
contribution has not been isolated at high simulation counts and should not be quoted as a separate gain.

**Pass is kept out of the tree until the board is developed.** A rollout can make an early pass look
harmless, because the opponent also passes at the end of the random continuation and the score comes out
the same as if the engine had played on — so MCTS will spend real visits on a branch that simply gives the
game away. `passReady` in `go-cognitive.js` scores pass at `-Infinity` in the prior until enough of the
board has been played for "stop" to be a credible choice, with one exception: if a complete Benson survey
says every remaining legal point is already settled, passing is safe however early that happened. On 20
paired games at 6000 simulations this scored 11/20 against 10/20 without it, with the average game 10 moves
shorter — no strength cost, and the premature-pass failure gone.

**Surveying inside the tree is worse than surveying at the root.** Re-reading life and death at every
expanded node scored 60.0% against 68.3% for a single root survey on the same 60 games. Root-only is both
cheaper and better, and is the default.

### Handicap ladder vs GNU Go level 1 (pre-Phase-1 policy)

Measured when no policy could score in an even game. Superseded by the even-game result above, kept because
it is what established the original gap.

| Handicap | Games | Score |
| ---: | ---: | ---: |
| 3 stones | 6 | 1/6 (16.7%) |
| 4 stones | 12 | 7/12 (58.3%) |
| 5 stones | 6 | 5/6 (83.3%) |
| 9 stones | 6 | 6/6 (100%) |

The pre-Phase-1 policy was roughly **4 handicap stones** weaker than GNU Go level 1.

### The regional matrix (Phase 2) — a negative result

`go-regions.js` implements the hierarchical design: Bouzy dilation/erosion influence segments the board into
regions, each region analyzes only its own points (stones, groups at risk, boundary contact), regions exchange
urgency laterally over a coupling graph, and the aggregate temperatures are piped upward to modulate the
global search's root priors.

It is fully built and it **measurably loses strength**:

| Policy | Games | Score | Average margin | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| `puct` (Phase 1) | 12 | **5/12 (41.7%)** | -43.0 | 19.3-68.0% |
| `matrix` (temperature v1) | 12 | 2/12 (16.7%) | -59.8 | 4.7-44.8% |
| `matrix` (temperature v2, boundary-focused) | 12 | 2/12 (16.7%) | -67.3 | 4.7-44.8% |

Head-to-head against `puct` at equal simulations, `matrix` scored 4/8 — roughly neutral. The region survey
costs 0.17ms per move against ~550ms of search, so equal-simulation is equal-wall-clock here and the
comparison is fair.

Two failure modes were found and fixed, and the result still did not improve:

1. **Rationing budget per region was wrong.** The first version split prior mass region by region, so a
   one-point region received comparable mass to a fifty-point contested zone — roughly 20x the per-point
   prior. That version lost 1/6 head-to-head. Replaced with a modulation that scales each move's own prior
   by its region's heat.
2. **Temperature initially rewarded empty space.** Scoring any neutral-influence region highly steered the
   search into open board and away from contact fights. Refocused onto boundary contact and groups at risk.

The honest reading is that the layer is **structurally redundant**. The per-point pattern priors already
encode local analysis — capture, atari, contact, proximity to the last move — at a finer grain than a
per-region scalar. Multiplying whole groups of moves by one shared factor cannot express anything the
per-point prior does not already, and it blurs a prior that was doing real work. Go's mid-game
non-decomposability makes the scalar summary discard precisely the couplings that matter.

What would plausibly make the idea pay, in rough order of promise:

- **Prune, don't re-weight.** Using regions to detect *settled* areas and remove them from the root move list
  is strictly informative — "do not search here" — rather than a re-weighting that competes with the prior.
- **Allocate simulations, not prior mass**, with each region running its own local search and the results
  combined by temperature. This is the combinatorial-game-theory method and is *provably correct in the
  endgame*, where regions genuinely are independent.
- **Restrict the layer to the late game**, where decomposition is valid, instead of applying it throughout.

The first of those is no longer hypothetical. `go-eyes.js` prunes on Benson's algorithm, which is exactly a
"do not search here" signal backed by a proof rather than a heuristic, and it does not blur the per-point
prior because it speaks in points at the same grain. That is the shape the region work should have taken.

### A known tuning problem

Across 688 Phase 1 decisions the governing plan was `defend` 320, `expand` 219, `endgame` 104, `enclose` 43,
and **`attack` just 2** (over 40 later games at 2000 sims the same imbalance held: `defend` 652, `expand`
431, `endgame` 221, `enclose` 92, `attack` 12). The attack frame effectively never governs, because its activation keys on enemy
groups at two liberties or fewer, which a stronger opponent rarely offers. This is untuned rather than
diagnosed — it may be correct deference, or the threshold may simply be wrong.

## The ladder guard

A ladder was this engine's most expensive blind spot, and it is the one tactic a rollout leaf is
structurally unable to see. In a random continuation the attacker does not reliably keep chasing, so a
doomed group survives most playouts and the leaf reports that running was fine. Meanwhile the priors
pay the engine to run: `Pat.score` alone gives `1.9 * log1p(rescue)`, and the `defend` and `live`
frames add more on top. The result is a chain lost one stone at a time, in a sequence that was already
decided at the first move.

`go-ladder.js` reads the sequence out instead of estimating it. A ladder is forced, so it can be
searched to a terminal answer: the escaper may extend or capture, the attacker may atari, and nothing
else is considered — which is exactly what makes an exact tactical search cheap enough to call from
inside the priors. Two details matter for correctness. The escaper is allowed to capture an adjacent
attacking chain in atari, which is what a **ladder breaker** is; a reader without that branch will
confidently tell you a group dies when in fact it takes the chasing stones off the board first. And a
read that exhausts its node budget answers "escapes", because a guard must never invent a capture it
did not actually finish seeing.

### Where it is consulted, and where it is not

The guard runs in `policyPriors`, on two questions: *would the group I am about to create get chased
down* (penalty 3.4) and *is the atari I am about to play a ladder I actually win* (bonus 1.3). Both are
in the same log-odds units as the rest of the priors, so the guard argues with the other features
rather than overriding them.

It is gated hard. Being short of liberties is not enough on its own — a lone stone on the 1-1 point is
strictly capturable in a first-line ladder, and an early version of this gate duly penalised every
corner of an empty board. Correct, and useless: that is the line prior's job. What makes a ladder worth
avoiding is an enemy stone already touching, so the read only runs on a contact move or on a rescue of
a group that is already in atari. In a typical midgame position the gate opens on about 5 candidates
out of 69, and the layer costs **9%** of time per move.

### Measured

40 games, colours alternating, 600 playouts a side. `tools/style-arena.cjs` counts a *ladder blunder*
every time a side plays a stone into a group the opponent can then chase down and capture outright —
the direct evidence, since a win rate alone cannot tell "stopped losing groups in ladders" from "got
luckier".

| | Guard on | Guard off |
| --- | --- | --- |
| Result | **25-15 (63% ± 8)** | 15-25 |
| Ladder blunders per game | **3.73** | 8.68 |
| Resulting liberties per move | 3.679 | 3.473 |

Blunders more than halve, and the engine plays measurably thicker as a side effect. On the specific
position the layer was built for — a black stone in atari on the A file with a white wall on B — the
doomed escape at A4 falls from rank 21 of 78 to rank 74 under the `defend` frame.

### Reading ladders inside the rollouts is a negative result

The obvious next step is to fix the leaf as well as the prior: stop the rollout from answering atari by
extending a group that is already lost, so a doomed escape stops *evaluating* as survivable. It is
implemented, it works, and it is off by default, because it does not pay:

| 40 games | Equal playouts (600 v 600) | Equal time (383 v 600) |
| --- | --- | --- |
| Rollout guard vs priors guard only | 26-14 (65% ± 8) | **16-24 (40% ± 8)** |

The check costs 89% of playout throughput — a ladder read per atari answer, in the hottest loop in the
engine. At equal playouts that buys a win; at equal time it buys 383 playouts instead of 600, and the
lost search is worth more than the tactical accuracy. It also barely moves the blunder count (5.75 vs
4.90), which says the priors were already catching what mattered. Equal playouts is the flattering
question and equal time is the real one, which is why `tools/style-arena.cjs` takes `--a-playouts` and
`--b-playouts` separately.

Turn it on with `--rollout-ladders on` if you ever run the engine at a fixed playout count rather than
a fixed clock.

## Play-style personalities

The engine can wear a personality fitted from a corpus of human 9x9 game records: `go-records/` holds
22,324 SGF files from a Go server, all 9x9, Chinese rules, komi 7. A personality is not a different
engine — it is an additive tilt on the priors, the plan seeds and the rollout policy, and at
`--style-weight 0` it reproduces the stock engine bit for bit.

```bash
npm run go:style                             # the whole pipeline: index, profile, cluster, fit
node engine.cjs --personality brawler        # GTP, or pick one in the browser front end
npm run go:style:arena                       # what each personality costs in strength
```

### Only the games that were scored

15,175 of the 22,324 records have no `RE[]` property: on this server that means the game ended in
resignation, timeout or abandonment. Their final stretch is either missing or played by someone who had
already given up, so style learned from those tails is style learned from noise. Filtering to scored
games leaves **7,149**, and dropping the server bots leaves **6,672 games / 13,344 sides**, every one of
which replays legally against the rules core. That verification is not ceremony: a record that does not
replay is a record we cannot learn from, and there is no way to know which kind you have without trying.

### The archetypes are measured, not asserted

`tools/style-profile.cjs` measures both sides of every game on sixteen axes — contact rate, answer rate,
tenuki rate, line distribution, capture and atari rates, self-atari, resulting liberties, opening shape,
game length — computed from the same `go-patterns` features the engine's own priors are built from. A
style axis the feature set cannot express is a style the engine has no way to imitate, so measuring one
would only produce archetypes it cannot play.

Between-player spread on those axes is real but modest, which raises the obvious question: is any of it
signal? `tools/style-cluster.cjs` answers it before clustering, by splitting each player's own games in
half and correlating the halves — how much of an axis replicates within one person:

| Axis | Reliability | Axis | Reliability |
| --- | --- | --- | --- |
| `margin` | .89 | `edge` | .56 |
| `openingCenter` | .70 | `selfAtari` | .55 |
| `center` | .66 | `third` | .52 |
| `answer` | .64 | `contact` | .49 |
| `openingEdge` | .62 | `tenuki` | .48 |
| `length` | .61 | `capture` | .47 |
| | | `atari` | .42 |
| | | `liberties` | .41 |
| | | `connect` | .33 |
| | | `rescue` | .19 |

Two consequences. `rescue` and `connect` are mostly noise and are dropped; every surviving axis is
z-scored and then **scaled by its own reliability**, because noise scaled to unit variance pulls a
k-means as hard as signal does. And `margin` — by far the most reliable axis — is excluded outright: it
replicates at .89 because it measures how *strong* someone is. Clustering on it would sort the corpus
into good and bad players and call the result personality.

k-means (k=5, k-means++ seeding, 40 restarts) over the 140 players with 20+ scored games:

| Archetype | Players | Games | Rating | What it does |
| --- | --- | --- | --- | --- |
| **Brawler** | 56 | 3,148 | 2370 | fights at contact, hunts atari, takes stones, plays into tight spots |
| **Skydiver** | 30 | 1,676 | 2325 | plays the centre, stays off the edge, opens high, finishes early |
| **Landgrabber** | 27 | 1,463 | 2308 | stays low, opens low, hugs the edge, jumps around the board |
| **Architect** | 23 | 1,088 | 2233 | keeps its stones breathing, rarely ataris, avoids contact |
| **Grinder** | 4 | 325 | 2201 | throws stones in, plays long games, ignores the last move |

### What is actually fitted

`tools/style-fit.cjs` fits a conditional logit over the legal moves of a position: the probability a
player chooses a move is the softmax of a linear score over the `go-patterns` features, plus a weight for
the canonical 3x3 shape being played into. Patterns are folded over the eight board symmetries — a corpus
this size cannot afford to treat a position and its reflection as two different things.

Everything is stored as a **difference from a pooled baseline** fitted the same way over equal numbers of
positions from every archetype. That makes a personality a tilt rather than a replacement, keeps the
engine's own judgement carrying the move, and makes `--style-weight 0` exactly the stock engine — which is
what makes the arena comparison below mean anything. The baseline is balanced across archetypes on
purpose: weighted by cluster size it becomes approximately the largest cluster's own model, and that
cluster's personality then measures as no personality at all.

The fitted deltas are legible. The Grinder's `selfAtari` weight is **+1.09** above baseline — those are
the throw-ins. The Skydiver pushes priors off lines 1-2 and onto lines 3-4. The Brawler pays more for
captures and ataris and less for liberties.

Each archetype also gets a symmetry-folded **opening book** of its own players' recorded choices (258
positions for the Brawler, 30 for the Grinder) and a set of **plan seeds** for the cognitive layer, so a
personality that fights begins the game already believing in `attack` rather than rediscovering it.

### Held out, and told apart

Fitted on 80% of each archetype's positions, scored on the 20% no model has seen:

```
held-out log-loss, model (row) on archetype (column) - lower is better
                Brawler  Skydiver Landgrabb Architect   Grinder
Brawler          2.4948    2.4648    2.5303    2.4981    2.4673
Skydiver         2.4937    2.4574    2.5377    2.4967    2.4528
Landgrabber      2.5102    2.4902    2.5249    2.5026    2.4691
Architect        2.5029    2.4727    2.5268    2.4911    2.4664
Grinder          2.5119    2.4799    2.5507    2.5151    2.4178
```

Four of five archetypes predict their own held-out moves better than any other archetype's model does;
the Brawler loses its own column to the Skydiver by 0.0011 nats, which is a tie. The models are telling
each other apart rather than all re-learning "play a good move". The gains are small in absolute terms —
0.010 to 0.034 nats over the baseline — and they should be: style is a second-order effect next to
legality and basic soundness, and a method that claimed otherwise would be overfitting.

### It shows up in play, and it is not free

`tools/style-arena.cjs` plays each personality against the stock engine, 20 games, colours alternating,
600 playouts a move for both sides, then measures both sides' moves with the same axes used on the corpus.

| Personality | vs stock | Style actually shifted |
| --- | --- | --- |
| **Architect** | **16-4 (80% ± 9)** | liberties +0.22, opens centre -0.06 |
| **Brawler** | 12-8 (60% ± 11) | atari +0.074, captures +0.045 |
| **Skydiver** | 10-10 (50% ± 11) | opens centre +0.058, tenuki -0.035 |
| **Grinder** | 9-11 (45% ± 11) | tenuki -0.026, liberties +0.11 |
| **Landgrabber** | **4-16 (20% ± 9)** | atari -0.096, liberties -0.23 |

The styles transfer: the Brawler really does atari 19% more often and capture 35% more often than the
same engine without it. But imitation and strength pull against each other, and two of these are well
outside the noise in both directions. The Architect's tilt — keep stones breathing, avoid contact — is
worth about +240 Elo at this budget, which says as much about the stock priors as about the archetype.
The Landgrabber's is worth about -240: playing low and answering less is a style the search cannot
support at 600 playouts. That is the honest result, it is why `styleWeight` is a dial rather than a
switch, and it is why the arena exists at all. A personality feature that is never measured against the
engine it modifies is a feature that quietly makes the bot worse.

Twenty games is a coarse instrument — the standard error is 9-11 points — so read the middle three as
"no measured difference" and only the two extremes as real.

### The moving parts

| File | Role |
| --- | --- |
| `go-sgf.js` | SGF reading: root properties and the main line, nothing else |
| `go-style.js` | Symmetry, canonical 3x3 pattern keys, the personality object, the opening book |
| `go-personalities.js` | The registry. If `data/personalities.json` is missing the engine still runs |
| `tools/sgf-index.cjs` | Records to one verified JSONL index of scored games |
| `tools/style-profile.cjs` | Per-game, per-side style vectors |
| `tools/style-cluster.cjs` | Reliability weighting, k-means, named archetypes |
| `tools/style-fit.cjs` | Conditional logit, pattern tables, opening books, held-out evaluation |
| `tools/style-arena.cjs` | Personality vs stock: strength cost and style verification |

Three settings control how loudly a personality speaks: `--style-weight` (the whole tilt, 0 disables),
`--book-weight` (the opening book) and `--playout-weight` (the rollout bias). The rollout bias costs
about 23% of playout throughput, which is why the flat pattern table is pre-exponentiated at load time —
a `Math.exp` per candidate per rollout move was costing 62%.

`go-records/` and the bulk intermediates are gitignored: the corpus is a personal archive, and everything
except `data/personalities.json` and `data/personality-clusters.json` regenerates from it in about two
minutes.

## Run it

```bash
npm test                      # rules, scoring, cognitive and eye-layer tests
npm run go:baseline:random    # random play vs GNU Go level 1
npm run go:baseline:flat      # flat Monte Carlo vs GNU Go level 1
npm run go:puct:level1        # the current engine vs GNU Go level 1
npm run go:ladder             # the ladder guard, measured against itself with the guard off
npm run go:style              # fit the play-style personalities from go-records/
npm run go:style:arena        # every personality vs the stock engine
```

The harness takes `--games --workers --policy --playouts --level --size --komi --handicap --anchor --seed`,
plus the search settings `--cpuct --fpu --rave --expand-threshold --eyes --eye-weight`. Every report records
the settings it ran with, so no two runs can be confused for one another.

### Play it yourself

`engine.cjs` speaks GTP, so any Go GUI (Sabaki, GoGui, Lizzie) or `gogui-twogtp` can drive it:

```bash
node nc-go/engine.cjs --playouts 6000        # point your GUI at this command
node nc-go/engine.cjs --personality brawler  # ...wearing a fitted play style
node nc-go/engine.cjs --ladders off          # ...with the ladder guard disabled
```

Three GTP extensions come with it: `nc-personality [id]` reads or sets the current personality (`none`
turns it off), `nc-personality-list` names them, and `nc-style-weight [0..4]` sets how strongly it speaks.
A GUI that does not know these commands simply never sends them.

### Playing a human is not the same as playing the benchmark

Tromp-Taylor removes no dead stones, so it is only correct on a board played to the bitter end. GNU Go is
launched with `--capture-all-dead --play-out-aftermath` precisely so that it will play that out. **A human
will not.** Against a person the engine therefore looks as though it does not understand the endgame: it
keeps capturing groups both players can see are dead, because under the rules it is scored by, they are not
dead until they come off the board.

`go-score.js` supplies the missing convention, and the method was chosen by measurement rather than taste.
Replaying 30 real games from the 200-game run and comparing against GNU Go's own `final_score`:

| Position | Raw Tromp-Taylor | Ownership threshold | **Settle, then score** |
| --- | ---: | ---: | ---: |
| Played to two passes | 30/30 exact | 30/30 | **30/30** |
| Stopped 10 moves early | 21/30 | 29/30 | **30/30** |
| Stopped 20 moves early | 6/30, mean error 13.3 | 25/30, mean 1.7 | **29/30, mean 0.1** |
| Stopped 40 moves early | 1/30, mean error 25.4 | 12/30, mean 11.8 | **17/30, mean 4.8** |

The first row is the important one: **on a completed board, area scoring is already exact.** Every error it
makes is an error about the board not being finished, not about the arithmetic. So the right method is not
to estimate which stones would have died — it is to finish the game and look.

`settleAndScore` does exactly that. The engine plays out both sides of the aftermath and the completed board
is scored. One detail decides whether it works at all: **passing has to be forbidden while any move remains
that is not an eye-fill.** An engine plays to *win*, so the moment it is ahead it passes and leaves the dead
stones standing — which is the position we were trying to resolve in the first place. Without that rule
settle-then-score got 2/30 at 20 moves early; with it, 29/30. This is the same reason GNU Go is launched with
`--capture-all-dead --play-out-aftermath`.

Two further findings worth recording:

- **A stronger settling engine is not a better one.** 200 simulations per aftermath move scores as well as
  1500, at a tenth the cost (~100ms per position), and taking the median of five settles changes nothing.
- **Random playouts are not enough.** Settling with a uniform-random policy scores 25/30 at 20 moves early
  against the engine's 29/30, and is far less stable (worst error 86 points against 4).

Ownership over many random playouts is kept, because it answers a different question the settled line
cannot: *how much of the board is still genuinely in dispute*. That is what gates the decision to end the
game — when the opponent passes, the engine passes back only if it is ahead in the settled line **and** few
points are still undecided. Being ahead is not enough on an open board, or it would agree to end a game that
is still anyone's.

This is a convention for human play, not a strength change: the benchmark numbers above are all played out
under Tromp-Taylor as before, where the first row of that table shows it is already exact.

For a quick browser board, run the included local page:

```bash
node play-server.cjs --playouts 3000
# open http://127.0.0.1:4173
```

The page is human Black versus the real PUCT engine as White. Use `--playouts 6000` for the benchmark
setting, or a smaller value for faster replies. `--dead-playouts` sets the budget for the dead-stone
overlay (600 by default). The server listens on all interfaces by default, so from another device on your
LAN open `http://<this-computer-ip>:4173`. This page has no authentication; only run it on a network you
trust. Use `--host 127.0.0.1` to make it local-only.

**Dead stones, live.** The panel's *Show dead stones* switch runs `finalScore`'s ownership read on every
move and fades the stones it believes are already lost, with a cross over each. Turned off, the board draws
plain stones and the score reverts to raw Tromp-Taylor area scoring — which counts dead groups as their
owner's territory, so the two readings disagree by exactly the amount still standing that should not be.
Mid-game the read is an estimate and firms up as the position settles; the threshold is deliberately high
(0.8), because a stone in trouble is not yet a dead stone.

**Passes are stated, not implied.** `lastMove` is `-1` after a pass, so no intersection carries the
last-move marker once someone has passed — the board never keeps pointing at a move that is no longer the
latest thing that happened. The panel says *White passed* in words instead.

### Deploying it

The page and the engine deploy to Vercel as-is: `public/index.html` is served statically and `api/game.js`
runs the search.

```bash
vercel deploy          # preview
vercel deploy --prod   # production
```

The web session is **stateless**: the client owns the move list and sends it with every request, and the
server replays it from an empty board before answering. Nothing has to survive between requests, so two
consecutive moves need not land on the same instance. A warm instance still carries its `mind` forward
whenever the incoming move list extends the one it last answered — a cold one simply starts fresh, which
costs it the accumulated plan support but nothing else. `NCGO_PLAYOUTS` (2000) and `NCGO_DEAD_PLAYOUTS`
(600) tune the per-request budget; at 2000 a move takes roughly 200ms, well inside the function's 30s
limit.

### Benchmark against a frozen snapshot, always

The harness forks a fresh process per game, so **editing the source while a run is in flight silently
changes the engine mid-run**. Two runs were lost to this before it was noticed. Copy the directory first and
run the harness from the copy.

## Scoring is cross-validated

`go-core.js` implements Tromp-Taylor area scoring with no dead-stone removal, which is only correct on a
board played to completion. GNU Go is therefore launched with `--chinese-rules --capture-all-dead
--play-out-aftermath` so it will not pass while dead stones remain. Every game records both our margin and
GNU Go's own `final_score`; on the first validation run the two agreed on 4 of 4 games.

Without those flags GNU Go passes early and our scorer reads an 80-point loss as a 4-point win. If the two
scores ever diverge in a report, that is the first thing to check.

## The anchor is an assumption

Stockfish exposes `UCI_Elo`, a calibrated strength dial, which is what made the chess ratings meaningful.
**GNU Go's `level 1..10` has no published Elo mapping.** Every rating this harness prints is a performance
rating relative to `--anchor`, defaulting to 1800 for GNU Go level 10 on the reasoning that the 9x9 CGOS
pool was historically pinned to GNU Go — *this value is not yet verified and should not be quoted until it
is*. Changing the anchor shifts every number by the same constant, so the score percentage is the real
measurement and the Elo is a derived convenience.

The handicap ladder is now implemented and measured, but it does **not** convert cleanly to kyu either:

- The "one handicap stone = one rank" convention is a **19x19** rule. On 9x9 a stone is worth substantially
  more, because it is the same stone on a board a quarter the size. There is no widely agreed 9x9 conversion.
- GNU Go 3.8 **level 1**'s own rank is not established anywhere we can cite. Published estimates for GNU Go
  describe level 10 on 19x19.

So "4 stones weaker than GNU Go level 1 on 9x9" is a real, reproducible measurement against a fixed reference,
and it is the honest ceiling of what this harness currently supports. **It is not yet a rating.** Getting a
rating needs an opponent whose rank is externally established — a CGOS pool entry, or a Pachi/KataGo build
configured to a known strength.

Reports for handicap runs deliberately print no Elo at all: the handicap has already paid the strength
difference in stones, so anchoring that score to an even-game Elo would count the compensation twice.

9x9 strength does not convert to a 19x19 rank.

## The cognitive layer

`go-patterns.js` scores a move by hand-authored Go features — capture size, atari escape, self-atari,
resulting liberties, contact, distance from the edge, and proximity to the opponent's last move. Nothing here
is trained; these are the shapes a human is taught first, and their weights are set by hand in the same
spirit as the chess evaluation.

`go-cognitive.js` runs five competing plans — **expand, enclose, attack, defend, endgame** — each drawing
graded support from board metrics (occupancy, territory, own danger, enemy danger, stage). Support decays
rather than resetting, so a plan that stops paying off is demoted instead of instantly forgotten, matching the
chess design. The governing plan then re-weights the move features: `attack` rewards moves that press a short
of liberties enemy group, `defend` rewards rescuing one's own, `expand` rewards the third and fourth lines
away from existing stones.

`go-ladder.js` reads ladders exactly and lends the priors an opinion about them; see **The ladder
guard** above for why that has to live in the priors rather than in the leaf.

`go-mcts.js` is the same PUCT loop as `src/cognitive-mcts.js`, with one architectural change: the leaf is a
light playout scored to a Tromp-Taylor terminal rather than `tanh(evaluate/600)`. Positional superko is
enforced at the root only; inside the tree simple ko keeps descent cheap.

## Why the design differs from the chess AI

Cognitive-PUCT in `src/cognitive-mcts.js` evaluates a leaf as `tanh(evaluate(state)/600)` over material,
king safety and development. Go has no material and no trustworthy static evaluation, so the leaf becomes a
light playout scored to a Tromp-Taylor terminal instead. That is the one genuine architectural change; the
select/expand/backup loop, the competing-plans layer and the episodic advisor all port structurally.

The practical consequence is budget. 2400 simulations bought roughly 1300 Elo in chess because each leaf was
a real evaluation. In Go each leaf is a full rollout, and 2400 rollouts is beginner strength — pattern-guided
MCTS needs 10k-100k. The upside for the thesis is that the cognitive layer is carrying proportionally more of
the strength here than it does in chess, because the evaluation underneath it is so much weaker.
