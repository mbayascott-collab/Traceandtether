---
name: Browser print test styling
description: Preserve real application print behavior in browser-generated PDF tests.
---

Browser-based PDF regression tests should load the application's actual print stylesheet, not only render the print document component.

**Why:** Without the print rules that hide the rest of the workspace and reveal only the preview, generated PDFs can include the underlying page and misrepresent what users save.

**How to apply:** When testing printing from an interactive page, serve the app stylesheet to the test browser and generate the PDF from the page after opening its real print preview.
