---
"triangle": minor
---

The app points at the measurement that is probably wrong. When the survey disagrees beyond tape
noise, the solver leaves each tape pull (and each constraint) out in turn and re-solves: the one
whose absence lets the rest agree is reported in the solve report as `suspects`, with what the rest
of the survey says the distance should be. The map draws it as a red dashed line and says which it
is; the measurement's sheet says so too. When the network has too few cross-checks to tell two
candidates apart, the app names both and asks for one more distance. A right angle that the tape
contradicts is named the same way.
