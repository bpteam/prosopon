import { VERDICTS, type CalibrationAnalysis, type Verdict } from './analysis';

/** Human- and agent-facing Markdown of a calibration bundle. Generated from the same data as summary.json. */

const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? 'n/a' : v.toFixed(digits));

type Manifest = Record<string, unknown> & {
  prosopon?: { commit?: string; dirty?: boolean | null };
  chatgpt?: { voice?: string | null; voiceMode?: string | null; voiceDetection?: string };
  languages?: string[];
};

export function renderReport(manifest: Manifest, analysis: CalibrationAnalysis): string {
  const s = analysis.summary;
  const out: string[] = [];
  out.push('# Prosopon calibration report', '');
  out.push(`Voice: **${s.voice}** (detected from: ${manifest.chatgpt?.voiceDetection ?? 'unknown'})  `);
  out.push(`Voice mode: ${manifest.chatgpt?.voiceMode ?? 'unknown'}  `);
  out.push(`Languages: ${s.languages.map((l) => l.toUpperCase()).join(' / ')}  `);
  out.push(`Commit: \`${manifest.prosopon?.commit ?? 'unknown'}\`${manifest.prosopon?.dirty ? ' (with uncommitted changes)' : ''}  `);
  out.push(`Samples: ${s.samples.valid} / ${s.samples.total} valid`, '');

  out.push('## Main findings', '');
  out.push('| Measure | Value |', '|---|---|');
  out.push(`| Semantic detection (expected cues found in the reply text) | ${pct(s.semanticDetection)} |`);
  out.push(`| Gesture policy acceptance (decisions accepted) | ${pct(s.policyAcceptance)} |`);
  out.push(`| Gesture starts (all sources / semantic) | ${s.gestureStarts} / ${s.semanticGestureStarts} |`);
  out.push(`| Visually meaningful gesture output | ${s.visiblyMeaningfulGestures} |`);
  out.push(`| Text clock: configured → suggested chars/s | ${s.pacing.configuredCharsPerSecond} → ${num(s.pacing.suggestedCharsPerSecond, 1)} |`);
  out.push('');
  out.push(`**Strongest suspected bottleneck:** ${s.bottleneck ? `\`${s.bottleneck}\`: ${s.bottleneckExplanation}` : 'none found'}`, '');
  if (s.pacing.textSource === 'none') {
    out.push('> No reply text was found on the page during voice replies: semantic results and speech rates are empty. ' +
      'Either ChatGPT voice mode does not render the reply text, or the assistant-message selector drifted.', '');
  }

  out.push('## Failure categories', '');
  const failures = Object.entries(s.verdicts).filter(([v]) => v !== 'OK') as [Verdict, number][];
  if (!failures.length) out.push('None.', '');
  else {
    out.push('| Category | Count | Meaning |', '|---|---|---|');
    for (const [v, n] of failures.sort((a, b) => b[1] - a[1])) out.push(`| \`${v}\` | ${n} | ${VERDICTS[v]} |`);
    out.push('');
  }

  out.push('## By language', '');
  out.push('| | chars/s | words/s | arousal | energy | high/low separated | gestures/min | semantic detection | policy acceptance | interruption → listening |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const lang of s.languages) {
    const l = s.byLanguage[lang];
    if (!l) continue;
    out.push(
      `| ${lang.toUpperCase()} | ${num(l.speechRate.charsPerSecond, 1)} | ${num(l.speechRate.wordsPerSecond, 1)} | ${num(l.assistantProsody.arousal)} | ${num(l.assistantProsody.energy)} | ${l.energyPair.separated === null ? 'n/a' : l.energyPair.separated ? 'yes' : 'no'} | ${num(l.gestures.perMinuteOfSpeech, 1)} | ${pct(l.semanticDetection)} | ${pct(l.policyAcceptance)} | ${l.interruption?.onsetToListening === null || l.interruption?.onsetToListening === undefined ? 'n/a' : `${l.interruption.onsetToListening}s`} |`,
    );
  }
  out.push('');

  out.push('## Samples', '');
  out.push('| Step | Valid | Verdicts |', '|---|---|---|');
  for (const r of analysis.results) {
    const verdicts = r.verdicts.map((v) => (v.verdict === 'OK' ? `${v.expect}: OK` : `${v.expect}: **${v.verdict}**${v.detail ? ` (${v.detail})` : ''}`)).join('; ');
    out.push(`| \`${r.step}\` | ${r.valid ? 'yes' : `no: ${r.invalidReason ?? ''}`} | ${verdicts.replace(/\|/g, '/')} |`);
  }
  out.push('');
  if (s.manualFlags.length) {
    out.push('## Marked as visually wrong', '');
    for (const f of s.manualFlags) out.push(`- \`${f.step}\`: ${f.reason}`);
    out.push('');
  }
  return out.join('\n');
}

export function renderAgentTask(manifest: Manifest, analysis: CalibrationAnalysis): string {
  const s = analysis.summary;
  const commit = manifest.prosopon?.commit ?? 'unknown';
  return `# Task: tune Prosopon from a real-world calibration bundle

You have a Prosopon real-world calibration bundle (this ZIP).

The calibration was recorded against repository commit:
\`${commit}\`${manifest.prosopon?.dirty ? ' (the build had uncommitted changes: compare config-before.json with care)' : ''}

Voice: ${s.voice}
Voice mode: ${manifest.chatgpt?.voiceMode ?? 'unknown'} (ChatGPT backend model: not reported by the page)
Languages: ${s.languages.join(', ')}
Samples: ${s.samples.valid} / ${s.samples.total} valid
Suspected bottleneck: ${s.bottleneck ?? 'none'}

## Files

| File | Content |
|---|---|
| \`manifest.json\` | commit, build, voice, runtime modes, browser, sample rates |
| \`config-before.json\` | every tunable as the recording build had it (defaults and live values, incl. the offscreen analysers) |
| \`scenarios.json\` | the samples, prompts and machine-readable expectations |
| \`results.json\` | per sample: observed cues, decisions, gestures (requested / applied / final amplitude), speech rate, prosody, verdicts |
| \`summary.json\` | aggregates per language, failure counts, bottleneck, measured speech rate |
| \`events.jsonl\` | state transitions, audio/utterance edges, semantic cues and intents, policy decisions, gesture lifecycle, interruptions, manual flags (epoch ms) |
| \`trace.jsonl\` | ~15 Hz: conversation state, signals, user VAD/pitch/spectral features, both EmotionFrames, mixer weights, gesture phase, per-source attribution of every head/body channel (idle, state, reaction, emotion, gesture → final) |
| \`features.jsonl\` | offscreen voice feature frames (25 Hz) of both channels while a clip was recording |
| \`assistant-text.jsonl\` | prompt, requested text and the text ChatGPT actually rendered |
| \`semantic.jsonl\`, \`gestures.jsonl\`, \`steps.jsonl\` | analysed/released intents with decisions; every gesture; raw step records |
| \`audio/\` | 16-bit mono WAV per sample at the capture rate (\`audio/index.json\`: start time, rate, truncation) |

## Your task

1. Inspect PRODUCT.md and the current repository first.
2. Compare the current code with config-before.json.
3. Analyse summary.json, results.json, events.jsonl and trace.jsonl.
4. Re-run relevant audio samples through the current analyzers where useful (the WAVs feed UserVoiceAnalyzer /
   ProsodyEmotionAnalyzer and the viseme analysers in a unit test or a Node script).
5. Determine the actual bottleneck for each failed calibration category.
6. Do not blindly increase global gesture rates or amplitudes.
7. Distinguish:
   - detection failure
   - semantic failure
   - policy suppression
   - gesture scheduling failure
   - insufficient gesture amplitude
   - BehaviorMixer attenuation
   - prosody normalization problem
   - pacing problem
   - interruption problem
8. Prefer the smallest generalizable configuration/code change.
9. Only introduce voice/language specific calibration if the data demonstrates a systematic difference.
10. Preserve all architecture invariants and architecture tests.
11. Add/update tests for every changed behaviour.
12. Update documentation if runtime behaviour changes.
13. Produce config-after.json and CALIBRATION_CHANGES.md.

## Reading the verdicts

${Object.entries(VERDICTS)
  .map(([k, v]) => `- \`${k}\`: ${v}.`)
  .join('\n')}

Thresholds of the analysis itself are in \`summary.json → thresholds\`; they judge the data, they are not avatar
settings. A sample marked invalid was not recorded properly (see \`invalidReason\`); do not tune on it.
`;
}
