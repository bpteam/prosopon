import {
  CALIBRATION_LANGUAGES,
  type CalibrationLanguage,
  type CalibrationScenario,
  type CalibrationStep,
  type SpeakingStyle,
  type StepExpectation,
} from './types';

/**
 * The quick full calibration: the same logical matrix in every language, so languages are compared on the same
 * categories rather than on different texts. Composite replies test several signals at once (the contrast sample is
 * also the long reply used for speech-rate measurement).
 *
 *   assistant: 7 samples × language (sent through the composer, spoken by ChatGPT Voice)
 *   user:      3 samples × user language, plus quiet and long speech once
 *   interruption: 1 × user language
 */

export const LANGUAGE_NAMES: Readonly<Record<CalibrationLanguage, string>> = Object.freeze({
  ru: 'Russian',
  uk: 'Ukrainian',
  en: 'English',
  es: 'Spanish',
});

interface AssistantCategory {
  category: string;
  style: SpeakingStyle;
  expected: StepExpectation;
  text: Record<CalibrationLanguage, string>;
}

const NO_SHAKE: StepExpectation['forbiddenGestureFamilies'] = ['headShake'];

export const ASSISTANT_CATEGORIES: readonly AssistantCategory[] = [
  {
    category: 'contrast.enumeration.long',
    style: 'natural',
    expected: { semantic: ['contrast', 'enumeration'], preferredGestureFamilies: ['hand', 'bodyShift', 'shoulderShift', 'headTilt'], forbiddenGestureFamilies: NO_SHAKE },
    text: {
      ru: 'Хорошо, давай разберёмся. Но здесь есть три важных момента. Во-первых, время. Во-вторых, деньги. И наконец, люди, которые будут этим заниматься. В итоге всё зависит от того, с чего ты начнёшь.',
      uk: 'Добре, давай розберемося. Але тут є три важливі моменти. По-перше, час. По-друге, гроші. І нарешті, люди, які цим займатимуться. Зрештою все залежить від того, з чого ти почнеш.',
      en: "Okay, let's figure this out. But there are three important points here. First, time. Second, money. And finally, the people who will do the work. In the end, it all depends on where you start.",
      es: 'Bien, vamos a verlo. Pero aquí hay tres puntos importantes. Primero, el tiempo. Segundo, el dinero. Y por último, las personas que harán el trabajo. Al final, todo depende de por dónde empieces.',
    },
  },
  {
    category: 'question.normal',
    style: 'question',
    expected: { semantic: ['question'], preferredGestureFamilies: ['headTilt', 'leanIn'], forbiddenGestureFamilies: NO_SHAKE },
    text: {
      ru: 'А ты уверен, что это лучший вариант? Может, стоит попробовать что-то другое?',
      uk: 'А ти впевнений, що це найкращий варіант? Може, варто спробувати щось інше?',
      en: "Are you sure this is the best option? Maybe it's worth trying something else?",
      es: '¿Estás seguro de que es la mejor opción? ¿Quizás valga la pena probar otra cosa?',
    },
  },
  {
    category: 'agreement.emphasis.conclusion',
    style: 'natural',
    expected: { semantic: ['agreement', 'conclusion'], preferredGestureFamilies: ['nod', 'leanIn', 'hand'], forbiddenGestureFamilies: NO_SHAKE },
    text: {
      ru: 'Да, именно так. Это действительно очень важно. Итак, главное — начать уже сегодня.',
      uk: 'Так, саме так. Це справді дуже важливо. Отже, головне — почати вже сьогодні.',
      en: 'Yes, exactly. This is really important. To sum up, the main thing is to start today.',
      es: 'Sí, exactamente. Esto es muy importante. Así que lo principal es empezar hoy.',
    },
  },
  {
    category: 'disagreement',
    style: 'natural',
    expected: { semantic: ['disagreement'], preferredGestureFamilies: ['headShake', 'headTilt'], forbiddenGestureFamilies: ['nod'] },
    text: {
      ru: 'Нет, это не совсем так. На самом деле всё как раз наоборот.',
      uk: 'Ні, це не зовсім так. Насправді все якраз навпаки.',
      en: "No, that's not quite right. Actually, it's the other way around.",
      es: 'No, eso no es del todo así. En realidad, es justo al revés.',
    },
  },
  {
    category: 'energy.high',
    style: 'energetic',
    expected: { semantic: [], preferredGestureFamilies: [], forbiddenGestureFamilies: [], prosody: 'high' },
    text: {
      ru: 'Отличная новость! Мы наконец-то это сделали, и результат просто потрясающий!',
      uk: 'Чудова новина! Ми нарешті це зробили, і результат просто неймовірний!',
      en: 'Great news! We finally did it, and the result is absolutely amazing!',
      es: '¡Qué gran noticia! ¡Por fin lo logramos y el resultado es increíble!',
    },
  },
  {
    category: 'energy.low',
    style: 'calm',
    expected: { semantic: [], preferredGestureFamilies: [], forbiddenGestureFamilies: [], prosody: 'low' },
    text: {
      ru: 'Ничего страшного. Давай спокойно подумаем об этом, никуда не торопясь.',
      uk: 'Нічого страшного. Давай спокійно подумаємо про це, нікуди не поспішаючи.',
      en: "Don't worry. Let's think about it calmly, there's no rush.",
      es: 'No pasa nada. Pensémoslo con calma, sin ninguna prisa.',
    },
  },
  {
    category: 'negative-control',
    style: 'natural',
    expected: { semantic: [], preferredGestureFamilies: [], forbiddenGestureFamilies: [], negativeControl: true },
    text: {
      ru: 'Сегодня вторник, на улице пятнадцать градусов, ветер северный, облачно.',
      uk: 'Сьогодні вівторок, на вулиці пʼятнадцять градусів, вітер північний, хмарно.',
      en: "Today is Tuesday, it's fifteen degrees outside, the wind is from the north, and it's cloudy.",
      es: 'Hoy es martes, hace quince grados, el viento sopla del norte y está nublado.',
    },
  },
];

interface UserCategory {
  category: string;
  style: SpeakingStyle;
  instruction: Record<CalibrationLanguage, string>;
  text: Record<CalibrationLanguage, string>;
}

export const USER_CATEGORIES: readonly UserCategory[] = [
  {
    category: 'normal',
    style: 'natural',
    instruction: { ru: 'Скажи обычным голосом:', uk: 'Скажи звичайним голосом:', en: 'Say in your normal voice:', es: 'Dilo con tu voz normal:' },
    text: { ru: 'Давай попробуем другой вариант.', uk: 'Давай спробуємо інший варіант.', en: "Let's try another option.", es: 'Probemos otra opción.' },
  },
  {
    category: 'question',
    style: 'question',
    instruction: { ru: 'Спроси с вопросительной интонацией:', uk: 'Запитай із питальною інтонацією:', en: 'Ask it as a question:', es: 'Pregúntalo:' },
    text: { ru: 'А можно сделать это быстрее?', uk: 'А можна зробити це швидше?', en: 'Can we do this any faster?', es: '¿Podemos hacerlo más rápido?' },
  },
  {
    category: 'energetic',
    style: 'energetic',
    instruction: { ru: 'Скажи бодро и громко:', uk: 'Скажи бадьоро й голосно:', en: 'Say it with energy:', es: 'Dilo con energía:' },
    text: {
      ru: 'Это просто отлично, мне очень нравится!',
      uk: 'Це просто чудово, мені дуже подобається!',
      en: "That's just great, I really love it!",
      es: '¡Es genial, me encanta de verdad!',
    },
  },
];

/** Asked once, in the first user language. */
export const USER_EXTRA_CATEGORIES: readonly UserCategory[] = [
  {
    category: 'quiet',
    style: 'calm',
    instruction: { ru: 'Скажи тихо, почти шёпотом:', uk: 'Скажи тихо, майже пошепки:', en: 'Say it quietly, almost whispering:', es: 'Dilo en voz baja, casi susurrando:' },
    text: { ru: 'Хорошо, я подумаю.', uk: 'Добре, я подумаю.', en: "Okay, I'll think about it.", es: 'Vale, lo pensaré.' },
  },
  {
    category: 'long',
    style: 'natural',
    instruction: { ru: 'Скажи спокойно, целиком:', uk: 'Скажи спокійно, повністю:', en: 'Say all of it calmly:', es: 'Dilo todo con calma:' },
    text: {
      ru: 'Я хочу рассказать, как прошёл мой день: утром я работал, потом встретился с друзьями, а вечером долго гулял по парку.',
      uk: 'Я хочу розповісти, як минув мій день: зранку я працював, потім зустрівся з друзями, а ввечері довго гуляв парком.',
      en: 'I want to tell you about my day: in the morning I worked, then I met some friends, and in the evening I took a long walk in the park.',
      es: 'Quiero contarte cómo fue mi día: por la mañana trabajé, luego vi a unos amigos y por la tarde di un largo paseo por el parque.',
    },
  },
];

export const INTERRUPTION_PHRASE: Readonly<Record<CalibrationLanguage, string>> = Object.freeze({
  ru: 'Подожди, у меня вопрос.',
  uk: 'Зачекай, у мене питання.',
  en: 'Wait, I have a question.',
  es: 'Espera, tengo una pregunta.',
});

const STYLE_INSTRUCTION: Readonly<Record<SpeakingStyle, string>> = Object.freeze({
  natural: 'Speak the following text naturally',
  energetic: 'Say the following text naturally but with noticeably higher energy',
  calm: 'Say the following text calmly and slowly',
  question: 'Say the following text as a genuine conversational question',
});

export function assistantPrompt(style: SpeakingStyle, language: CalibrationLanguage, text: string): string {
  return `${STYLE_INSTRUCTION[style]} in ${LANGUAGE_NAMES[language]}. Reply with the text only, exactly as written:\n\n"${text}"`;
}

export interface ScenarioOptions {
  /** Languages of the assistant samples (default: all four). */
  languages?: readonly CalibrationLanguage[];
  /** Languages the user is asked to speak (default: the same). */
  userLanguages?: readonly CalibrationLanguage[];
  /** Assistant categories to run (default: all). */
  categories?: readonly string[];
  /** Include user and interruption steps (default true). */
  user?: boolean;
}

/** The default run is QUICK FULL CALIBRATION: every language, every category. */
export function buildScenario(options: ScenarioOptions = {}): CalibrationScenario {
  const languages = [...(options.languages ?? CALIBRATION_LANGUAGES)];
  const userLanguages = [...(options.userLanguages ?? languages)];
  const categories = ASSISTANT_CATEGORIES.filter((c) => !options.categories || options.categories.includes(c.category));
  const steps: CalibrationStep[] = [];
  for (const language of languages) {
    for (const c of categories) {
      const text = c.text[language];
      steps.push({
        id: `${language}.${c.category}`,
        kind: 'assistant',
        language,
        category: c.category,
        style: c.style,
        requestedText: text,
        prompt: assistantPrompt(c.style, language, text),
        expected: c.expected,
      });
    }
  }
  if (options.user !== false) {
    userLanguages.forEach((language, index) => {
      const set = index === 0 ? [...USER_CATEGORIES, ...USER_EXTRA_CATEGORIES] : USER_CATEGORIES;
      for (const c of set) {
        steps.push({
          id: `${language}.user.${c.category}`,
          kind: 'user',
          language,
          category: `user.${c.category}`,
          style: c.style,
          requestedText: c.text[language],
          instruction: c.instruction[language],
          expected: { semantic: [], preferredGestureFamilies: [], forbiddenGestureFamilies: [] },
        });
      }
    });
    for (const language of userLanguages) {
      const long = ASSISTANT_CATEGORIES[0]!.text[language];
      steps.push({
        id: `${language}.interruption`,
        kind: 'interruption',
        language,
        category: 'interruption',
        style: 'natural',
        requestedText: INTERRUPTION_PHRASE[language],
        prompt: assistantPrompt('natural', language, long),
        instruction: 'When the indicator appears, interrupt ChatGPT by saying:',
        expected: { semantic: [], preferredGestureFamilies: [], forbiddenGestureFamilies: ['hand'] },
      });
    }
  }
  return { id: options.categories || options.languages ? 'custom' : 'quick-full', languages, steps };
}
