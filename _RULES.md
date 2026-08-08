# AEM → EDS Conversion Rules

This document defines the rules used to convert AEM XML structure into EDS-compliant page sections.
Rules are applied in order during `aem-canvas.js` canvas build.

---

## Global Style Defaults

These padding defaults apply to ALL converted sections and grid-containers:

| Output type | Has `backgroundColor`? | Padding class added |
|---|---|---|
| `grid-container` | YES | `regular-padding` |
| `grid-container` | NO | _(no padding class added)_ |
| `section` | YES | `section-padding` |
| `section` | NO | _(no padding class added)_ |

---

## Scope of Body Rules

All rules operate **only on the direct children of `responsivegrid1`** (one level deep). They do NOT recurse.

**Dispatch for each direct child:**
- If it is a `container` with **no nested container children** → Rule 1 or Rule 4
- If it is a `container` with **one or more nested container children** → Rule 6+
- If it is a `grid` → Rule 3
- If it is a `separator` → Rule 2
- If it is any other component → Rule 5

**Rules 1–5 only apply when the container's children contain NO nested containers.** If any child of the container is itself a container, Rule 6+ applies instead.

---

## Phase 0 — Hero separation (pre-pass)

Before any body processing, scan `responsivegrid1` top-level nodes from the start:

- Node is **hero** if it has `backgroundImageReference` (the bg-image container)
- Following nodes are **hero continuation** if they carry the `overlap-predecessor` style ID
- Stop consuming hero nodes at the first node that does NOT have `overlap-predecessor`

The hero nodes are passed to `emitHero()` → produces `section[0]`.
All remaining nodes are **body nodes** processed by the rules below.

---

## Body Rules

### Rule 1 — Container with grid-only children

**Trigger:** A body-level `container` node whose **only** children are one or more `grid` nodes (no other component types, and no nested containers).

**Output:** One `grid-container` section per grid child.

Each `grid` → `grid-container` with:
- `grid-section` children, one per `par_*` cell in that grid
- Each `grid-section` gets `grid-cols-{columnWidth}` and `order-{dataPriority}` from the grid's column definition
- Components inside each `par_*` cell → mapped to EDS blocks unchanged

**Section styles** (on each `grid-container`):
- All `cq:styleIds` on the **container** → resolved via `style-map.json` → added as EDS classes
- `backgroundColor` on the container → `bg-{hex}` (strip `#`, lowercase)
- If container has `backgroundColor` → add `regular-padding` to the `grid-container`
- Nothing is dropped — all resolved style IDs are kept

**Child component styles:** Each component's own `cq:styleIds` → resolved as `dyn:[...]` or `com:[...]` via `style-map.json`. No changes.

**Example — `container_829993285` (us/en/join-us):**
```
AEM:
  container  bgColor:#0066F5  styleIds:[medium-radius, width-policy, height-short, no-bottom-margin]
    grid  cols:[w8/p1, w2/p3, w2/p2]
      par_11: title + text
      par_12: (empty)
      par_13: button

EDS:
  grid-container  cls:[grid-container, medium-radius, height-short, no-bottom-margin, bg-0066f5, no-side-margin, regular-padding]
    grid-section [grid-cols-8, order-1]
      custom-title
      text-container
    grid-section [grid-cols-2, order-3]
      (empty)
    grid-section [grid-cols-2, order-2]
      cta
```

---

### Rule 2 — Orphaned top-level separator

**Trigger:** A `separator` node sitting directly in `responsivegrid1` (not inside any container).

**Output:** Wrap in its own `section` with fixed classes.

```
section  cls:[content-wide, no-bottom-margin]
  separator  dyn:[{resolved from style-map.json}]
```

**Section styles:** Always exactly `content-wide` + `no-bottom-margin` — fixed, no lookup.
**Separator block styles:** `cq:styleIds` on the separator → resolved via `style-map.json` → `dyn:[...]`.

**Example — AEM node [3] (us/en/join-us):**
```
AEM:  separator  styleIds:[1662756409908 → separator-height-16]

EDS:  section cls:[content-wide, no-bottom-margin]
        separator dyn:[separator-height-16]
```

---

### Rule 3 — Bare top-level grid (no container wrapper)

**Trigger:** A `grid` node sitting directly in `responsivegrid1` (not inside any container).

**Output:** One `grid-container` section.

The grid → `grid-container` with:
- `grid-section` children, one per `par_*` cell
- Each `grid-section` gets `grid-cols-{columnWidth}` and `order-{dataPriority}` from the grid's column definition
- Components inside each `par_*` cell → mapped to EDS blocks unchanged

**Section styles:**
- `cq:styleIds` on the grid itself → resolved via `style-map.json` → added as EDS classes
- No `backgroundColor` (bare grids don't carry bg color) → no `regular-padding` added
- If the grid has no styleIds, only `content-wide` is applied (no padding)

**Child component mapping:** Each component inside a `par_*` cell follows the standard AEM → EDS block mapping (e.g. `cardpagestory` → `story-card`, `title` → `custom-title`, `text` → `text-container`, etc.). Each component's own `cq:styleIds` → resolved via `style-map.json` → applied as `dyn:[...]` or `com:[...]` on the EDS block. No special treatment.

**Example — `grid_752592403` (us/en/join-us):**
```
AEM:
  grid  styleIds:none  rowCount:1
    cols: [w3/p1, w6/p1, w3/p1]
    par_11: cardpagestory styleIds:[card-dashboard, hide-image-show-desc, card-medium]
    par_12: cardpagestory styleIds:[card-dashboard, card-medium, medium-theme]
    par_13: cardpagestory styleIds:[card-dashboard, card-medium, dark-theme]

EDS:
  grid-container  cls:[grid-container, content-wide]
    grid-section [grid-cols-3]
      story-card dyn:[card-dashboard, hide-image-show-desc, card-medium]
    grid-section [grid-cols-6]
      story-card dyn:[card-dashboard, card-medium, medium-theme]
    grid-section [grid-cols-3]
      story-card dyn:[card-dashboard, card-medium, dark-theme]
```

---

### Rule 4 — Container with mixed children (components + grids interleaved)

**Trigger:** A body-level `container` node whose children are a mix of plain components (header, title, text, teaser, separator, etc.) AND one or more `grid` nodes — and NO nested containers.

**Algorithm:** Walk the container's children in order. Accumulate non-grid components into a running `section`. When a `grid` is encountered, emit the current section (if non-empty), emit the grid as a `grid-container`, then start a new empty section for subsequent children. Repeat until all children are processed. Emit any trailing section if non-empty.

```
currentSection = []
for each child of container:
  if child is grid:
    if currentSection is non-empty → emit section(currentSection)
    emit grid-container(child)
    currentSection = []          ← start fresh
  else:
    currentSection.append(child) ← accumulate component
if currentSection is non-empty → emit section(currentSection)
```

**Styles on every emitted section AND grid-container:**
- All `cq:styleIds` on the **container** → resolved via `style-map.json` → inherited by ALL sections and grid-containers produced
- `backgroundColor` on the container → `bg-{hex}` → inherited by ALL
- If container has `backgroundColor` → `regular-padding` on each `grid-container`, `section-padding` on each `section`
- Nothing is dropped

**Child component mapping:** Same AEM→EDS block mapping + `style-map.json` for `dyn:[...]`/`com:[...]`.

**Example — `copy_of_container_co_658719712` (us/en/join-us):**
```
Container styles: default-radius, container-full-width, height-default, no-bottom-margin, bg-f1f3ff

Children:
  [1] header       ← component
  [2] title        ← component
  [3] separator    ← component
  [4] grid_1       ← GRID
  [5] teaser       ← component
  [6] grid_2       ← GRID
  [7] separator    ← component

Processing:
  [1][2][3] → section (header, title, separator)     ← non-empty before grid_1
  [4]       → grid-container (grid_1)
  [5]       → section (teaser)                       ← non-empty before grid_2
  [6]       → grid-container (grid_2)
  [7]       → section (separator)                    ← trailing non-empty

EDS output (all inherit container styles):
  section            cls:[default-radius, container-full-width, height-default, no-bottom-margin, bg-f1f3ff, ...]
    eyebrow-text
    custom-title
    separator
  grid-container     cls:[default-radius, container-full-width, height-default, no-bottom-margin, bg-f1f3ff, regular-padding]
    grid-section [grid-cols-6] → eyebrow-text, custom-title, separator, custom-image
    grid-section [grid-cols-1] → (empty)
    grid-section [grid-cols-5] → quote
  section            cls:[default-radius, container-full-width, height-default, no-bottom-margin, bg-f1f3ff, ...]
    teaser
  grid-container     cls:[default-radius, container-full-width, height-default, no-bottom-margin, bg-f1f3ff, regular-padding]
    grid-section [grid-cols-4] → custom-image, eyebrow-text, text-container
    grid-section [grid-cols-4] → custom-image, eyebrow-text, text-container
    grid-section [grid-cols-4] → custom-image, eyebrow-text, text-container
  section            cls:[default-radius, container-full-width, height-default, no-bottom-margin, bg-f1f3ff, ...]
    separator
```

---

### Rule 5 — Orphaned top-level component

**Trigger:** Any non-container, non-grid, non-separator component sitting directly in `responsivegrid1` (e.g. `teaser`, `title`, `accordion`, `text`, etc.).

**Output:** Same as Rule 2 — wrap in its own `section` with fixed classes.

```
section  cls:[content-wide, no-bottom-margin]
  {component-block}  dyn:[{resolved from style-map.json}]
```

**Section styles:** Always exactly `content-wide` + `no-bottom-margin` — fixed, no lookup.
**Component block styles:** The component's own `cq:styleIds` → resolved via `style-map.json` → `dyn:[...]`.

**Example — `us/en/science` node [8]:**
```
AEM:  title  styleIds:[width-xx-large, medium-weight, align-center, h3-size]

EDS:  section cls:[content-wide, no-bottom-margin]
        custom-title dyn:[width-xx-large, medium-weight, align-center, h3-size]
```

**Example — `us/en/science` node [2]:**
```
AEM:  teaser  styleIds:[1]

EDS:  section cls:[content-wide, no-bottom-margin]
        teaser dyn:[{resolved from styleId 1}]
```

---

### Rule 6 — Container with nested container children

**Trigger:** A body-level `container` node where **at least one direct child is itself a container**.

**Algorithm:**
Walk the outer container's children in order:
- If child is a **nested container** → walk its children and apply Rule 4 logic (accumulate components → section, grids → grid-container). Each output section/grid-container inherits:
  - Outer container's `cq:styleIds` (resolved) → base styles
  - Nested container's `backgroundColor` (if present) → `bg-{hex}` added on top
  - Nested container's own `cq:styleIds` (if present) → also added on top
  - Padding: apply Global Style Defaults based on whether the nested container has `backgroundColor`
- If child is a **direct component** (non-container, non-grid) → emit as a `section` with outer container's styles only (no nested container styles)
- If child is a **direct grid** (no nested container) → emit as `grid-container` with outer container's styles only

**Style inheritance summary:**
| Output source | Base styles | Additional styles |
|---|---|---|
| From nested container's grid | outer `cq:styleIds` + outer `bg` | nested `cq:styleIds` + nested `bg` |
| From nested container's component | outer `cq:styleIds` + outer `bg` | nested `cq:styleIds` + nested `bg` |
| From direct component child of outer | outer `cq:styleIds` + outer `bg` | (none) |
| From direct grid child of outer | outer `cq:styleIds` + outer `bg` | (none) |

**Example — `copy_of_container_co_918492323` (us/en/science):**
```
OUTER:  styleIds:[container-full-width, height-default, no-padding, no-bottom-margin]  bgColor:none

  INNER[container]        styleIds:[no-bottom-margin]  bgColor:none
    └─ grid_copy_copy     [grid]
         par_11, par_12, par_14

  INNER[container_copy]   styleIds:(none)  bgColor:#F1F3FF
    ├─ grid               [grid]
    │    par_11, par_12, par_13
    └─ grid_copy          [grid]
         par_11, par_12, par_13

Processing:
  [container]      → has grid_copy_copy → emit grid-container
                      styles: outer[container-full-width, height-default, no-padding, no-bottom-margin]
                            + inner[no-bottom-margin]
                            + no bgColor → no padding
  [container_copy] → has grid + grid_copy → emit 2 grid-containers
                      styles: outer[container-full-width, height-default, no-padding, no-bottom-margin]
                            + inner bgColor:#F1F3FF → bg-f1f3ff + regular-padding

EDS output:
  grid-container  cls:[container-full-width, height-default, no-padding, no-bottom-margin]
    grid-section [grid-cols-...]  ← from grid_copy_copy par_11
    grid-section [grid-cols-...]  ← from grid_copy_copy par_12
    grid-section [grid-cols-...]  ← from grid_copy_copy par_14

  grid-container  cls:[container-full-width, height-default, no-padding, no-bottom-margin, bg-f1f3ff, regular-padding]
    grid-section [grid-cols-...]  ← from grid par_11
    grid-section [grid-cols-...]  ← from grid par_12
    grid-section [grid-cols-...]  ← from grid par_13

  grid-container  cls:[container-full-width, height-default, no-padding, no-bottom-margin, bg-f1f3ff, regular-padding]
    grid-section [grid-cols-...]  ← from grid_copy par_11
    grid-section [grid-cols-...]  ← from grid_copy par_12
    grid-section [grid-cols-...]  ← from grid_copy par_13
```

---

### Rule 7 — Container with PreBuilt Template grid

**Trigger:** Any of the following:
- A `container` whose own `cq:styleIds` includes a PreBuilt Template ID
- A `container` whose direct `grid` child has a PreBuilt Template styleId
- A `grid` (at any nesting level) whose `cq:styleIds` includes a PreBuilt Template ID

In all cases, the PreBuilt Template styleId is detected by looking up `style-map.json` and checking `groupLabel === "PreBuilt Templates"`. The template class (`grid-full-page-5-v1`, `grid-half-page-2`, etc.) drives the layout.

PreBuilt Template styleIds:
| ID | EDS class | Layout |
|---|---|---|
| `1` / `165354545645741` | `grid-full-page-4` | 4-cell full-page |
| `2` / `165354545645742` | `grid-full-page-5-v1` | 5-cell full-page v1 |
| `3` / `165354545645743` | `grid-full-page-5-v2` | 5-cell full-page v2 |
| `4` / `165354545645744` | `grid-half-page-2` | 2-cell half-page |
| `5` / `165354545645745` | `grid-half-page-3` | 3-cell half-page |
| `165354545645746` | `grid-meganav-3` | Mega Nav 3 |
| `165354545645747` | `grid-meganav-4` | Mega Nav 4 |

**Algorithm:**
Count ALL grids in the entire container subtree (at any depth, including inside nested containers):

- **0 or 1 grid total** → NO `inner-grid`. Flatten all blocks into a single `section`. Styles collated from container + grid (if present), including `backgroundImageReference`, `backgroundColor`, all `cq:styleIds`.
- **More than 1 grid total** → One `inner-grid` per grid. The `inner-grid` block carries **no styles** — it is a plain structural wrapper. Blocks from that grid's `par_*` cells go inside the inner-grid.

**Style collation:**
- All styles (container `cq:styleIds`, `backgroundColor`, `backgroundImageReference`, grid `cq:styleIds`) go onto the **section** only
- `inner-grid` blocks themselves have no classes

**Single-grid example (`copy_of_container_co_434891104` — 1 PreBuilt Template grid + nested container with 1 grid = 2 grids total):**

Since total grid count > 1 → each grid gets its own `inner-grid`:

```
AEM:
  container  bgImg:/science/abbvie-src-scout.jpg  bgColor:#F4F4F4
             styleIds:[large-radius, container-full-width, height-default, no-bottom-margin]
    grid_953894820        styleIds:[2(grid-full-page-5-v1)]   ← PreBuilt Template
    container
      grid (cols 5-1-3-3) styleIds:[...]

EDS:
  section  cls:[large-radius, container-full-width, height-default, no-bottom-margin, bg-f4f4f4, grid-full-page-5-v1]
           background:/science/abbvie-src-scout.jpg

    inner-grid
      dashboard-cards (par_11)
      dashboard-cards (par_12)
      dashboard-cards (par_14)
      dashboard-cards (par_15)
      dashboard-cards (par_23)

    inner-grid
      eyebrow-text   com:[col-1]
      custom-title   com:[col-1]
      text-container com:[col-1]
      linklist       com:[col-3]
      linklist       com:[col-4]
```

**Zero-grid flat example:**
```
AEM:
  container  bgColor:#0066F5  styleIds:[grid-full-page-4, no-bottom-margin]
    title
    text
    cta

EDS:
  section  cls:[grid-full-page-4, no-bottom-margin, bg-0066f5]
    custom-title
    text-container
    cta
```

---

### Rule 8 — Inner-grid (block-level, inside par cell)

**Scope:** This rule operates at **block level** — inside a `par_*` cell while collecting leaf blocks. It does NOT operate at section level like Rules 1–7.

**Trigger:** While collecting leaf blocks for a `par_*` cell, a child `container` is found that has:
1. `backgroundColor` that is **non-empty AND not `#ffffff`** (white bg containers are flattened, not inner-grid)
2. At least one direct `grid` child (through layout wrappers only, not through nested containers)

**Output:**
```
inner-grid  classes:[cols-{w1}-{w2}-..., bg-{hex}, {container-styleIds}, {grid-styleIds}]
  block1  com:[col-1, ...]    ← from par_{r}1 cell
  block2  com:[col-2, ...]    ← from par_{r}2 cell
  block3  com:[col-3, ...]    ← from par_{r}3 cell
```

- `cols-{widths}` — column widths joined from the grid's column definitions
- `bg-{hex}` — from container's `backgroundColor`
- Container's resolved `cq:styleIds` — layout classes
- Grid's resolved `cq:styleIds` — layout classes
- Blocks are flat (no cell wrapper) with `col-{N}` added to each block's common classes

**Key distinction from Rule 7 inner-grid:**
| | Rule 7 inner-grid | Rule 8 inner-grid |
|---|---|---|
| Level | Section-level (inside `section`) | Block-level (inside `par_*` cell) |
| Styles on inner-grid | None | cols + bg + container + grid styles |
| Trigger | PreBuilt Template styleId | Non-white bgColor + direct grid |

**Example:**
```
AEM:
  [top-level container] → Rule 4 → grid-container
    grid
      par_11
        container  bgColor:#F4F4F4  styleIds:[container-xxx-large, align-center]
          grid     styleIds:[no-bottom-margin]  cols:[w6/p1, w1/p1, w5/p1]
            par_11: image
            par_12: (empty)
            par_13: title, text, linklist

EDS (inside par_11 cell of outer grid):
  inner-grid  classes:[cols-6-1-5, bg-f4f4f4, container-xxx-large, align-center, no-bottom-margin]
    custom-image    com:[col-1]
    custom-title    com:[col-3]
    text-container  com:[col-3]
    linklist        com:[col-3]
```

---

### Rule 9 — Related Content card band (heading + card grid)

**Scope:** Fires **inside** a container during `emitNode` when a direct `custom-title` child is immediately followed by a sibling grid that contains `cardpagestory`/`story-card` cells.

**Trigger:** Direct child is `custom-title` AND its next sibling is a grid where `gridHasCards()` is true.

**Algorithm:**
1. Flush any pending grid-container band
2. Emit the `custom-title` as its own standalone `section` (with container styles)
3. Set `relatedGridPending = true`
4. When the next grid is processed → `relatedContent = true`:
   - Add `no-top-padding` to the grid-container (removes visual gap between heading band and cards)
   - Call `applyRelatedContentCardProps()` on each `story-card` block:
     - Removes shared style classes: `quote-standard`, `card-medium`, `hide-description`
     - Sets `storyCardVariant: relatedContent`
     - Sets `hideDescription: {Boolean}true`
     - Sets `hidePublicationDate: {Boolean}true`
     - Sets `hideReadTime: {Boolean}true`
     - Sets `hideRole: {Boolean}false`
     - Sets `showChevron: {Boolean}true`
     - Sets `openInNewTab: {Boolean}false`
5. After the card grid is emitted → flush grid band, reset `relatedGridPending = false`

**Output:**
```
section [container-styles]                        ← heading band (no top padding gap)
  custom-title

grid-container [container-styles, no-top-padding] ← card grid tight against heading
  grid-section → story-card [relatedContent variant, no dynamic classes]
  grid-section → story-card [relatedContent variant, no dynamic classes]
  grid-section → story-card [relatedContent variant, no dynamic classes]
```

---

### Rule 10 — Footer separator hoisting (post-processing pass)

**Scope:** Post-processing pass applied AFTER all sections are built — `hoistTrailingSeparator()` runs on the final sections array.

**Trigger:** The last section in the page contains a `separator` as its last (or only) block.

**Algorithm:**
1. If the last section's last child is a `separator` → pop it, push it as its own bare section
2. If the last section has only blocks (no grid-sections) and the last block is a separator → pop it, push bare section
3. Ensure the final trailing section with a single separator always gets `footerSeparatorSectionProps`:
   - Classes: `content-wide, section-padding, no-bottom-margin`
   - Ensures the footer spacer is always a wide, padded, standalone band

**Output:**
```
... (previous sections)
section [content-wide, section-padding, no-bottom-margin]   ← always last before footer
  separator  dyn:[...]
```

**Note:** This fires regardless of which rule produced the separator's original section. It is a global cleanup pass, not tied to any specific AEM pattern.

---

## Cross-cutting: Container Width Propagation

This mechanism is **not a standalone rule** — it fires automatically inside `collectLeaves()` and `collectCellLeaves()` during any rule that collects leaf blocks (Rules 1, 3, 4, 6, 7, 8, 9).

**What it does:** When a container has a `container-*` width styleId, that width is translated to a `width-*` class and propagated down to all descendant leaf blocks.

**Mapping:**
| Container styleId (AEM) | Block width class (EDS) |
|---|---|
| `container-x-small` | `width-x-small` |
| `container-small` | `width-small` |
| `container-medium` | `width-medium` |
| `container-large` | `width-large` |
| `container-x-large` | `width-x-large` |
| `container-xx-large` | `width-xx-large` |
| `container-xxx-large` | `width-xxx-large` |

**How it applies to blocks:**
- `custom-title`, `text-container`, `video`, `brightcove-video` → inherited width replaces own width class in `classes_customDynamicClass`
- `video`/`brightcove-video` → `width-*` converted to `video-*`
- All other blocks → inherited width added to `classes_commonCustomClass`

**Inner container wins:** If a container is nested inside another container with a width style, the **innermost container's** width overrides the outer one. The width propagated to leaf blocks always comes from the nearest ancestor container with a `container-*` styleId.

**Example (`us/en/science` → `container2 > container3`):**
```
AEM:
  container2  styleIds:[container-xx-large, ...]
    container3  styleIds:[container-x-large, ...]    ← inner wins
      title    own-styleIds:[width-xx-large]         ← own width overridden
      text     own-styleIds:[width-xx-large]         ← own width overridden

EDS leaf blocks:
  custom-title    dyn:[width-x-large, ...]   ← container3's container-x-large wins
  text-container  dyn:[width-x-large]        ← same
```

---

## Rule Dispatch Order

```
PRE-PASS:
  Phase 0  — Hero separation (runs once before body loop)

PER TOP-LEVEL NODE (direct children of responsivegrid1):
  Rule 7   — Container/grid has PreBuilt Template styleId? → Rule 7
  Rule 6   — Container has any nested container children?  → Rule 6
  Rule 3   — Node IS a bare grid?                         → Rule 3
  Rule 2   — Node IS a bare separator?                    → Rule 2
  Rule 1   — Container with grid-only children?           → Rule 1
  Rule 4   — Container with mixed components + grids?     → Rule 4
  Rule 5   — Anything else (orphaned component)?          → Rule 5 (catch-all)

INSIDE expandGrid / collectCellLeaves (block-level):
  Rule 9   — direct custom-title before card grid?        → Rule 9 (related content)
  Rule 8   — nested container with non-white bg + grid?   → Rule 8 (inner-grid)

POST-PROCESSING (after all sections built):
  Rule 10  — trailing separator hoisting                  → Rule 10 (footer separator)
```

---

## Pending rules (to be defined)

_(none — all known patterns covered by Rules 1–10)_
