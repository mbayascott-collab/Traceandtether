---
name: Print preview isolation
description: Prevent hidden workspace content from adding blank pages to printed previews.
---

Print previews opened from inside a long workspace must be isolated from the surrounding workspace during printing. Making the rest of the UI invisible does not remove its layout height and can create blank PDF pages.

**Why:** A short customer quote first printed with blank trailing pages because the hidden workspace remained in print layout. After isolation, the user's browser still added a blank leading page because the preview wrapper and document used different named-page rules. An earlier browser test did not load the real stylesheet, so it missed the issue.

**How to apply:** For print-preview changes, isolate the preview from app layout and set the document body and wrapper to the same named page as the document. Browser regression tests should load the actual print stylesheet and assert a short document remains one page when surrounded by long app content.
