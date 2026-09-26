import type { SemanticCueType, SemanticLocale } from '../../src/semantic/SemanticCue';

/** [text, expected cue type] — the cue must be among the segment's cues. */
export type Fixture = readonly [string, SemanticCueType];
/** [text, cue type that must NOT be detected]. */
export type NegativeFixture = readonly [string, SemanticCueType];

/**
 * Positive fixtures per category and language. Hand-written in the style of ChatGPT replies (the cloud can't
 * reach ChatGPT; see docs/semantic-calibration.md for the manual check on real replies).
 */
export const POSITIVE: Record<SemanticCueType, Record<SemanticLocale, readonly string[]>> = {
  question: {
    en: ['Why?', 'What do you think?', 'Does that make sense?', 'Would you like me to show an example?', 'So which one should we pick?'],
    ru: ['Почему?', 'Что думаешь?', 'Имеет ли смысл это делать?', 'Хочешь, я покажу пример?', 'А что если попробовать иначе?'],
    uk: ['Чому?', 'Що думаєш?', 'Чи має сенс це робити?', 'Хочеш, я покажу приклад?', 'А що якщо спробувати інакше?'],
    es: ['¿Por qué?', '¿Qué te parece?', '¿Tiene sentido hacerlo?', '¿Quieres que te muestre un ejemplo?', 'Y si probamos otra cosa?'],
  },
  enumeration: {
    en: ['There are three options.', 'Firstly, it is fast.', 'Second, it is cheap.', 'Last but not least, it is simple.', '1. Measure first.', 'Here are a few reasons:'],
    ru: ['Есть три варианта.', 'Во-первых, это быстро.', 'Во-вторых, это дёшево.', 'И последнее: это просто.', '1. Сначала измерь.', 'Вот несколько причин:'],
    uk: ['Є три варіанти.', 'По-перше, це швидко.', 'По-друге, це дешево.', 'І останнє: це просто.', '1. Спочатку виміряй.', 'Ось кілька причин:'],
    es: ['Hay tres opciones.', 'En primer lugar, es rápido.', 'En segundo lugar, es barato.', 'Por último, es simple.', '1. Mide primero.', 'Hay varias razones:'],
  },
  contrast: {
    en: ['But there is a catch.', 'However, it is slow.', 'On the other hand, it scales.', 'That said, I would test it.', 'It works, although it is slow.', 'The problem is the latency.'],
    ru: ['Но есть нюанс.', 'Однако это медленно.', 'С другой стороны, это масштабируется.', 'Тем не менее я бы проверил.', 'Это работает, хотя и медленно.', 'Проблема в том, что задержка велика.'],
    uk: ['Але є нюанс.', 'Однак це повільно.', 'З іншого боку, це масштабується.', 'Тим не менш я б перевірив.', 'Це працює, хоча й повільно.', 'Проблема в тому, що затримка велика.'],
    es: ['Pero hay un matiz.', 'Sin embargo, es lento.', 'Por otro lado, escala bien.', 'No obstante, lo probaría.', 'Funciona, aunque es lento.', 'El problema es la latencia.'],
  },
  conclusion: {
    en: ['So overall, it works.', 'Therefore, I would pick the second one.', 'In conclusion, keep it simple.', 'The bottom line is that it depends.', "I'd go with the second option."],
    ru: ['Поэтому я бы сделал иначе.', 'Таким образом, всё работает.', 'В итоге выбираем второй вариант.', 'Подводя итог, держи это простым.', 'Я бы выбрал второй вариант.'],
    uk: ['Тому я б зробив інакше.', 'Отже, все працює.', 'У підсумку обираємо другий варіант.', 'Підсумовуючи, тримай це простим.', 'Я б обрав другий варіант.'],
    es: ['Por lo tanto, elegiría la segunda.', 'En conclusión, mantenlo simple.', 'En resumen, funciona.', 'Así que yo elegiría la segunda.', 'Mi recomendación es probarlo.'],
  },
  agreement: {
    en: ['Yes.', 'Exactly.', "That's right.", "You're right, it is faster.", 'Absolutely, go for it.', 'Right.'],
    ru: ['Да.', 'Именно.', 'Совершенно верно.', 'Ты прав, так быстрее.', 'Правильно.', 'Да, именно так.'],
    uk: ['Так.', 'Саме так.', 'Цілком правильно.', 'Ти правий, так швидше.', 'Правильно.', 'Згоден.'],
    es: ['Sí.', 'Exactamente.', 'Así es.', 'Tienes razón, es más rápido.', 'Claro.', 'Correcto.'],
  },
  disagreement: {
    en: ['No.', 'Not exactly.', "That's not quite right.", 'I disagree.', 'Quite the opposite.', 'More precisely, it is a queue.'],
    ru: ['Нет.', 'Не совсем так.', 'Это неверно.', 'Не соглашусь.', 'Ровно наоборот.', 'Если точнее, это очередь.'],
    uk: ['Ні.', 'Не зовсім так.', 'Це неправильно.', 'Не погоджуся.', 'Якраз навпаки.', 'Якщо точніше, це черга.'],
    es: ['No.', 'No exactamente.', 'Eso no es correcto.', 'No estoy de acuerdo.', 'Todo lo contrario.', 'Mejor dicho, es una cola.'],
  },
  emphasis: {
    en: ['This is really important.', 'Most importantly, test it.', 'Keep in mind that it is slow.', '**Never** do this in production.', 'The key point is latency.'],
    ru: ['Это очень важно.', 'Самое главное — тестировать.', 'Имей в виду, что это медленно.', 'Обрати внимание на задержку.', 'Главное: не смешивать слои.'],
    uk: ['Це дуже важливо.', 'Найголовніше — тестувати.', 'Май на увазі, що це повільно.', 'Зверни увагу на затримку.', 'Головне: не змішувати шари.'],
    es: ['Esto es muy importante.', 'Lo más importante es probarlo.', 'Ten en cuenta que es lento.', 'Fíjate en la latencia.', 'Lo importante: no mezclar capas.'],
  },
};

/** Critical false positives and conflicts (spec list first). */
export const NEGATIVE: readonly NegativeFixture[] = [
  ['Даже если это работает, так нельзя.', 'agreement'],
  ['Задача простая.', 'agreement'],
  ['Передача данных идёт медленно.', 'agreement'],
  ['Правильный способ такой.', 'agreement'],
  ['Правильная настройка решает всё.', 'agreement'],
  ['No obstante, hay que verlo.', 'disagreement'],
  ['Так как это медленно, лучше иначе.', 'agreement'],
  ['Move it to the right.', 'agreement'],
  ['Right now it is slow.', 'agreement'],
  ['Es un color claro.', 'agreement'],
  ['Correct implementation requires tests.', 'agreement'],
  ['The correct answer depends on load.', 'agreement'],
  ['Не совсем правильно.', 'agreement'],
  ['Неправильно.', 'agreement'],
  ['Не зовсім правильно.', 'agreement'],
  ['Невірно.', 'agreement'],
  ['That is not correct.', 'agreement'],
  ['Not exactly right.', 'agreement'],
  ["It isn't correct.", 'agreement'],
  ['No es correcto.', 'agreement'],
  ['Incorrecto.', 'agreement'],
  ['Правильно?', 'agreement'],
  ['Right?', 'agreement'],
  ['Это не важно.', 'emphasis'],
  ["That's not important.", 'emphasis'],
  ['Как видно, всё работает.', 'question'],
  ['Когда вы запускаете сервер, он стартует.', 'question'],
  ['What matters is latency.', 'question'],
  ['How it works is simple.', 'question'],
  ['Es rápido.', 'question'],
  ['Nobody knows.', 'disagreement'],
  ['Not only fast but also cheap.', 'contrast'],
  ['Не только быстро, но и дёшево.', 'contrast'],
  ['Рік тому це працювало.', 'conclusion'],
  ['Это "но" в кавычках.', 'contrast'],
  ['Sure that works for small data, it is fine.', 'agreement'],
];

/** [text, cues that must all be present]. */
export const MULTI: readonly (readonly [string, readonly SemanticCueType[]])[] = [
  ['Да, но есть нюанс.', ['agreement', 'contrast']],
  ['Exactly, but there is one issue.', ['agreement', 'contrast']],
  ['Так, але є нюанс.', ['agreement', 'contrast']],
  ['Sí, pero hay un matiz.', ['agreement', 'contrast']],
  ['Но главное: этого делать нельзя.', ['contrast', 'emphasis']],
  ['But the important part is this.', ['contrast', 'emphasis']],
  ['Поэтому главное — не торопиться.', ['conclusion', 'emphasis']],
  ['Во-первых, это **критически важно**.', ['enumeration', 'emphasis']],
  ['No exactamente: más bien es una cola.', ['disagreement']],
];

/** [text, the only cue among agreement/disagreement/contrast that must win]. */
export const CONFLICTS: readonly (readonly [string, SemanticCueType, SemanticCueType])[] = [
  ['No obstante, funciona.', 'contrast', 'disagreement'],
  ['Не совсем правильно.', 'disagreement', 'agreement'],
  ['Не зовсім правильно.', 'disagreement', 'agreement'],
  ['Not exactly.', 'disagreement', 'agreement'],
  ['Даже если так, работает.', 'contrast', 'agreement'],
];
