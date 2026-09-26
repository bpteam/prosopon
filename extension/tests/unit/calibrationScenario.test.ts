import { describe, expect, it } from 'vitest';
import { SemanticAnalyzer } from '@avatar/semantic/SemanticAnalyzer';
import { ASSISTANT_CATEGORIES, buildScenario } from '../../src/calibration/scenarios';
import { CALIBRATION_LANGUAGES } from '../../src/calibration/types';

function cuesOf(text: string): Set<string> {
  const analyzer = new SemanticAnalyzer();
  const found = new Set<string>();
  for (const intent of analyzer.update('m', text, true)) for (const c of intent.cues) found.add(c.type);
  return found;
}

describe('calibration scenario', () => {
  it('is the same matrix in every language, with unique step ids', () => {
    const s = buildScenario();
    expect(s.languages).toEqual([...CALIBRATION_LANGUAGES]);
    const ids = s.steps.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lang of CALIBRATION_LANGUAGES) {
      expect(s.steps.filter((x) => x.kind === 'assistant' && x.language === lang).map((x) => x.category)).toEqual(ASSISTANT_CATEGORIES.map((c) => c.category));
    }
    // 7 × 4 assistant, 3 × 4 + 2 user, 4 interruptions.
    expect(s.steps.filter((x) => x.kind === 'assistant')).toHaveLength(28);
    expect(s.steps.filter((x) => x.kind === 'user')).toHaveLength(14);
    expect(s.steps.filter((x) => x.kind === 'interruption')).toHaveLength(4);
  });

  it('expectations match what the current vocabulary finds in the requested text', () => {
    for (const c of ASSISTANT_CATEGORIES) {
      for (const lang of CALIBRATION_LANGUAGES) {
        const found = cuesOf(c.text[lang]);
        for (const type of c.expected.semantic) expect(found.has(type), `${lang}.${c.category}: ${type} in [${[...found]}]`).toBe(true);
        if (c.expected.negativeControl) expect([...found], `${lang}.${c.category}`).toEqual([]);
      }
    }
  });

  it('prompts carry the requested text verbatim', () => {
    for (const step of buildScenario().steps.filter((x) => x.kind === 'assistant')) expect(step.prompt).toContain(`"${step.requestedText}"`);
  });
});
