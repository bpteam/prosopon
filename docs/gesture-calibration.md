# Gesture calibration (needs your eyes)

Context: [PRODUCT.md §5.10](../PRODUCT.md#510-gestures), code and tunables:
[avatar/README.md](../avatar/README.md#gestures). Rules: [AGENTS.md](../AGENTS.md).

Amplitudes, rates and durations in `avatar/src/avatar/gesture/GestureConfig.ts` were set by reasoning, not by
looking at the model. Budget: ~20 minutes.

## Sandbox (fast loop)

`cd avatar && npm run dev`, open the **Gestures** folder.

1. Turn **Auto gestures** off. Press each button a few times at *trigger intensity* 0.5 and 0.9.
   - **Nod / Double Nod**: a clear but small chin dip; the second dip of the double nod is smaller.
   - **Head Tilt**: transient, returns to neutral; must not look like the `thinking` state (set the state to
     thinking and compare: the state tilt stays, the gesture comes and goes).
   - **Body Shift / Shoulder Shift**: barely noticeable weight shift; face stays towards the camera.
   - **Hand Emphasis**: the forearm is partly out of the default Waist frame; switch the *Camera* folder to Full
     body, or watch the shoulder/upper arm. Check for arm clipping into the torso at 0.9 (rotate the avatar in the
     *Avatar* folder). The side is random; press several times to see both.
   Adjust the sliders under *Amplitudes*, then *copy settings* and paste the JSON into the thread.
2. Axis signs are the risky part on another VRM: if a hand swings backwards or inwards, flip the sign of
   `armForward` / `armOutward` / `elbowBend`.
3. Turn **Auto** on, play a recorded ChatGPT answer (Lip Sync → *play audio file…*, Emotion → *audio source is:
   assistant*). Expect a gesture every ~10–30 s on lively speech, almost none on calm speech. `rate ×` scales all
   rates for tuning (1 = shipped).

## Extension (real conversation)

`cd extension && npm run build:dev`, enable Prosopon on chatgpt.com, *Microphone reactions* on. The overlay has a
`gesture` line (type · phase · intensity · total · nods · cooldown).

| # | Do | Expect |
|---|----|--------|
| 1 | Say a full sentence (> 0.5 s), stop | usually a nod (85 %), never on "uh"/a cough |
| 2 | Talk for 20 s non-stop | at most one listening nod, no continuous nodding |
| 3 | Ask for a long, lively answer | occasional head/body gestures; hand emphasis rare |
| 4 | Interrupt the assistant mid-gesture | the gesture releases within ~0.15 s, no arm motion while you talk |

Page-console hooks (dev build):
`document.dispatchEvent(new CustomEvent('prosopon:gesture', { detail: { trigger: 'nod' } }))`, also
`{ cancel: true }`, `{ auto: false }`, `{ seed: 1 }`, `{ config: { rateScale: 3, nodOnUtteranceChance: 1 } }`.
