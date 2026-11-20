# OSMD rendering compatibility regression

Run only the renderer regression, not the full application browser suite:

```sh
npx tsx --test tests/render/open-octave.test.ts
```

The harness launches the installed Chrome channel headlessly (set `SCORECRAFT_BROWSER_PATH` to a Chromium or Chrome executable to use that binary instead), injects the installed OSMD browser bundle, and transpiles the actual display compatibility helper in memory. It starts no server and writes no screenshot. The fixture is a newly authored CC0 two-measure structural study, not copied from a user's music.

OSMD 1.9.9 crashes in `calculateSingleOctaveShift` when an octave shift lacks an end expression. The renderer already chooses the last graphical measure for this case, but then passes its missing end timestamp to `Fraction.lte`. The compatibility helper supplies that same end-of-score boundary in the disposable OSMD model. It does not remove a note, modify the source XML, or change playback. The component displays a warning because a missing OMR stop marker does not establish the composer's intended range.

The regression first asserts the real unmodified OSMD crash, then checks successful rendering with the actual helper, unchanged musical-data fingerprint, and an untouched properly closed octave shift.

To run all renderer tests, use `npm run test:render`, for example `SCORECRAFT_BROWSER_PATH=/path/to/chrome npm run test:render`. These tests use authored fixtures and do not read a local score library.
