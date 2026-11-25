---
name: Print preview isolation
description: Prevent hidden workspace content from adding blank pages to printed previews.
---

Print previews opened from inside a long workspace must be isolated from the surrounding workspace during printing. Making the rest of the UI invisible does not remove its layout height and can create blank PDF pages.

**Why:** A short customer quote printed with several blank pages because the hidden quote workspace still participated in print layout. An earlier browser test did not load the real stylesheet, so it missed the issue.

**How to apply:** For print-preview changes, ensure the document is outside the app's print flow and hide the app shell from pagination. Browser regression tests should load the actual print stylesheet and assert a short document remains one page when surrounded by long app content.
