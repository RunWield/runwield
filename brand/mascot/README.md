# RunWield mascot concept

The owner approved the animation family and its TUI/Workspace integration. Production one-bit frames live in
`src/ui/mascot/frames.ts`; `loops/preview.html` remains the interactive study. The generated concept sheets below are
historical references.

## Shared character

The main README has two small animated SVG companions in `readme/`: Base greets the reader near installation, and
Reviewer reads along near the technical overview. They adapt to light/dark backgrounds and show a still pose for reduced
motion. Regenerate them from the production frames with
`bun brand/mascot/readme/build.ts`.

Compact angular creature with white body, black face, square eyes, split feet, and an armless W silhouette. The same
anatomy carries every role. The companion is separate from the existing logo.

Target production palette: one foreground and one background, strictly two colors. The generated concept sheet includes
raster edge smoothing; it is a visual reference, not a verified 1-bit sprite atlas. Production sprites should be
authored on one small logical grid and checked at actual size in both surfaces.

## Roles

Init and Router share Base, with the blinking terminal cursor. The direction sign belongs to Guide alone.

| Agent            | Identifying feature                         | Suggested motion                                      |
| ---------------- | ------------------------------------------- | ----------------------------------------------------- |
| Guide            | Direction paddle                            | Small paddle turn                                     |
| Planner / Slicer | Clipboard                                   | One writing hand                                      |
| Architect        | Three stacked building blocks               | Three successive drops, pause, disappear, repeat      |
| All Engineers    | Keyboard                                    | Alternating hands                                     |
| Operator         | Lever                                       | Rocks left/right with a pause at each end             |
| Reviewer         | Long scroll held in front, with rolled ends | Eyes scan left to right, reset as paper advances      |
| Ideator          | Lightbulb                                   | Fill loop during thinking; solid when response begins |

The Ideator fill is an activity animation, not an estimate of thinking completion. Only the observed start of an answer
makes it stay solid. A static pose should be available for reduced motion.

## Small rendering target

Start with a 16-pixel-tall body and a shared canvas large enough for the role props. Check whether the props remain
distinct before choosing final dimensions. Unicode half blocks can represent two vertical pixels per text cell: space,
upper half block, lower half block, full block. A 16 by 16 bitmap therefore occupies 16 columns and 8 rows, subject to
terminal font proportions. A single-line indicator needs a simpler face plus the written agent name.

Unicode block reference: https://unicode.org/charts/nameslist/n_2580.html

Latest family sheet: `concept-v3.png`, with the revised Reviewer reading loop. `concept-v2.png` retains the Ideator fill
sequence. The concept sheets retain the earlier book proposal. The live animation study in `loops/preview.html` now
gives Architect three building blocks; Reviewer keeps the scroll.

## Generation prompts

### Initial concept

Use case: stylized-concept. Create a clean, highly disciplined pixel-art mascot concept sheet for RunWield, a coding
agent tool. This is a NEW companion character, not a redesign of the logo. Input image is reference only for angular
personality and the separate square cursor motif; do not reproduce the mint color. Strict palette: pure BLACK and pure
WHITE only. No gray, no antialiasing, no shadows, gradients, texture, or decorative clutter. Crisp coarse square pixels
on a black background. All characters must look plausible on a 24 by 24 logical pixel grid, not detailed illustrations.
Tiny readability is the primary design objective. Character: a small appealing angular imp/tool companion with a broad
compact body, two white square eyes cut out of its black inset face, two short angular upper corners and a distinctive
W-shaped lower silhouette with two chunky feet. White body with black face aperture. No mouth needed. Two tiny block
hands. Expressive and competent, not a generic spherical robot, no antenna. Strong simple silhouette. Keep EXACT same
base anatomy, face, eye spacing, scale across all variants. Props must not cover its face. Character should feel like a
living piece of terminal typography. Single coherent designed sheet. Title 'RUNWIELD / MASCOT STUDY'. Two rows of three
generously spaced large pixel specimens: 1 'BASE': character with no accessory; detached little square cursor at right.
2 'ROUTER': same creature, small black bow tie cut out in white body, holding one bold white direction paddle with a
black arrow; butler-meets-crossing-guard. 3 'PLANNER': same creature holding a chunky upright clipboard at one side,
just two black horizontal marks and clip. 4 'ARCHITECT': same creature holding a big open book at lower torso, clear
central black spine, no tiny page details. 5 'ENGINEER': same creature with hands over a wide small keyboard beneath
face, six large black key cuts maximum. 6 'REVIEWER': same creature holding one oversized square-framed magnifier to one
side, face stays visible. Below, a small restrained strip labeled 'THINKING / 4 POSES' with four copies of BASE showing
eyes open looking left, eyes centered, eyes looking right, then blink. Keep feet anchored, subtly shift one square
cursor to indicate activity; do not squash or rotate whole body. At bottom, show each of the six main variants again as
much smaller miniatures, same simple pixel design, labeled 'SMALL-SIZE CHECK'. Do not claim an exact pixel dimension on
the sheet. Layout is refined and spacious, all supporting text small white monospaced lettering. Pure black background
and pure white artwork. No extra logos, no color, no watermark. Prioritize extremely simple, bold, manufacturable pixel
shapes over illustrative detail.

### Revised concept with Ideator

Edit this RunWield mascot concept sheet. Preserve the appealing base character identity: chunky white compact creature,
high angular corner ears, black rectangular face with two white square eyes, W-like split feet, small hands. Preserve
the role concepts Router with bow tie and arrow paddle, Planner with clipboard, Architect with open book, Engineer with
keyboard, Reviewer with magnifying glass. CRITICAL CORRECTION: the input has unwanted gray edging, glows, outlines,
mottled noise and texture. REMOVE ALL OF THESE COMPLETELY. Re-render as absolutely clean FLAT 1-BIT pixel artwork: ONLY
solid RGB 0,0,0 and 255,255,255. Fully opaque SOLID BLACK canvas. Hard stair-stepped pixel edges. No transparency. No
gray. No gray face: face aperture must be pure black. No gradients, highlights, shadows, glow, distressed edges,
antialiasing, dots, noise or paper texture anywhere including text. Reference old image only for character design, never
its rendering artifacts. Black and white squares only. New layout: restrained title RUNWIELD / MASCOT STUDY. Seven
character variants in two spacious rows of four positions; first row BASE, ROUTER, PLANNER, ARCHITECT. Second row
ENGINEER, REVIEWER, IDEATOR, and a small explanatory sample labeled TINY SIZE showing the base very small. IDEATOR is
same creature with one big lightbulb above and to the right, connected visually by its raised hand; bulb simple
square-pixel outline with short base and empty center, no filament, no rays. Reviewer glass must clearly show a square
open lens and diagonal handle, big readable prop. Under the main grid, a strip labeled IDEATOR / THINKING LOOP shows
four identical Ideator characters with bulb progressing outline only, lower third solid white, lower two thirds solid
white, outline only again. Caption WAITING beneath this loop is not necessary. Separate final sample at right labeled
ANSWERING shows identical Ideator with bulb completely filled white. The bulb fill is a playful loop during thinking,
solid when response begins, not a progress prediction. Keep body pose and feet fixed through sequence; one frame may
blink. One large accessory per role. Large coarse logical pixels like a sprite made on a 20-24 pixel grid. Keep same
identity and proportions across all specimens. This must be plain flat videogame pixel art with no shader treatment.
Text clean plain white mono. Generous pure black spacing.
