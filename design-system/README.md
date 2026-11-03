# Trade Desk Design System

An extracted guide to the visual language already used in the Business Management Platform. This is a separate reference; it does not change the app screens.

## Design intent

Trade Desk is an owner-run operations workspace for keeping products, stock, suppliers, sales, and money in view. Its interface should feel steady and practical: warm paper surfaces, dark teal navigation, and copper details. Dense business information should stay easy to scan.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `ink` | `#203A3C` | Main text and headings |
| `ink-soft` | `#536A69` | Supporting text |
| `muted` | `#778985` | Hints and secondary labels |
| `line` | `#DCE4DC` | Dividers and quiet borders |
| `line-strong` | `#C7D3CA` | Input and button borders |
| `paper` | `#FFFEFA` | Panels and controls |
| `canvas` | `#F3F5EF` | Main page background |
| `canvas-deep` | `#E9EEE6` | Recessed backgrounds |
| `teal` | `#176B62` | Main actions and links |
| `teal-deep` | `#104F4B` | Hover and dark action states |
| `teal-wash` | `#E6F1EB` | Quiet teal emphasis |
| `copper` | `#B5653F` | Small highlights and active markers |
| `copper-wash` | `#FBEFE6` | Quiet copper emphasis |
| `olive` | `#64784E` | Positive notices |
| `danger` | `#A54C3E` | Errors and destructive actions |
| `danger-wash` | `#F9EAE6` | Error backgrounds |

Use teal for the main action, copper for secondary emphasis, and reserve danger colors for risk. Do not rely on color alone to communicate a status.

## Typography

- **Interface:** DM Sans, with a system sans-serif fallback.
- **Headings:** Manrope, with DM Sans as the fallback.
- **Amounts and identifiers:** IBM Plex Mono.
- Page titles are compact and prominent; section titles are smaller and clear.
- Use uppercase, letter-spaced labels sparingly for metadata and table headings.

## Layout and shape

- Main canvas uses a soft green-gray tint; content panels use warm off-white.
- Desktop workspace uses a 246px navigation rail and a centered content area capped near 1260px.
- Common spacing steps are 4, 8, 12, 16, 24, and 32px.
- Panels and tables use 9px corners; standard controls use 6–7px corners; status pills are fully rounded.
- Keep data tables information-dense but readable, with horizontal scrolling on narrow screens.
- Use subtle borders and restrained shadows instead of heavy elevation.

## Components

- **Primary button:** teal fill, warm-white text, 39px minimum height.
- **Secondary button:** warm-white fill, stronger border, dark teal text.
- **Quiet button:** transparent until hover.
- **Danger button:** white surface with a red border and text.
- **Inputs:** warm-white surface, quiet border, visible teal focus ring.
- **Panels:** warm-white surface, fine border, 9px corner radius.
- **Tables:** pale header row, uppercase labels, thin row separators, subtle hover state.
- **Status badges:** green for active, copper for draft, neutral gray for inactive.
- **Notices:** use a colored icon and plain-language message, not color alone.

## Motion and accessibility

- Keep hover and transition effects subtle and quick (about 120–160ms).
- Preserve clear keyboard focus with a visible teal outline.
- Respect `prefers-reduced-motion`.
- Maintain readable text contrast and meaningful accessible names for controls.

## Source and boundaries

This guide was extracted from the current app stylesheet (`src/index.css`). It records existing design choices; it does not apply changes to app screens. The accompanying preview is a standalone sample of these tokens and components.
