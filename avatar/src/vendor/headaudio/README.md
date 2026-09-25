# HeadAudio (vendored)

Source: https://github.com/met4citizen/HeadAudio at `d3af5f9ff86ab6b2b1913d411a4e1922ec101953`, MIT (see `LICENSE`).
Not published on npm, so the built files are copied as-is:

- `src/vendor/headaudio/headaudio.min.mjs` ← `dist/headaudio.min.mjs` (main-thread AudioWorkletNode; typed by `headaudio.min.d.mts`)
- `public/lipsync/headaudio/headworklet.min.mjs` ← `dist/headworklet.min.mjs` (worklet processor, loaded by URL)
- `public/lipsync/headaudio/model-en-mixed.bin` ← `dist/model-en-mixed.bin` (pre-trained English viseme model)

To update: rebuild or copy the same three files from a newer commit and change the hash above.
