# Shot List Skill

## Overview

Turn a short story beat into a numbered shot list of camera actions, subjects, and framing as text nodes on the canvas.

## Workflow

1. Analyze the creative prompt or narrative beat.
2. Break it down into numbered shots (e.g. Shot 1 Wide Establishing, Shot 2 Medium Action, Shot 3 Close-up Reaction).
3. Call `canvas.applyPatch` to create corresponding `text` nodes on the canvas.
