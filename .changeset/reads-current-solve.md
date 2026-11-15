---
"triangle": patch
---

The map and the DXF show the current solve. A garden's stored coordinates are the last solve
written by an edit; after the solver improved (0.0.13), an unedited garden showed the new residuals
on the old, wrong layout. Reads now place each point where the same solve that reports the
residuals puts it — and an unplaceable point as unplaced, not at its old spot. The next edit writes
the coordinates for good, as before.
