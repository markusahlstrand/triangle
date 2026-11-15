---
"triangle": minor
---

The solver no longer depends on the order points were measured in. When placing one point at a
time leaves points unplaced or the tape disagrees, it also starts from a global guess — every point
at once, from all the distances (classical MDS over shortest paths), in both mirror images — and
keeps whichever result places the most and fits best. A house tied to the garden baseline by three
verified pulls now places, and one bad pull early in the order no longer sends later side choices
the wrong way. A two-distance point with no side chosen still waits for the person. Also fixed: a
point waiting for its side was listed once per placement pass.
