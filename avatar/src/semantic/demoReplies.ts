import type { SemanticLocale } from './SemanticCue';

/**
 * Long, ChatGPT-like replies with every discourse function in them (agreement, question, contrast, enumeration,
 * emphasis, correction, conclusion). Written by hand, not captured from ChatGPT: the sandbox plays them
 * (Semantic folder), the density test counts what they would animate. Plain spoken-style text first (what voice
 * mode shows), then a structured part with a list (what text chat shows).
 */
export const DEMO_REPLIES: Readonly<Record<SemanticLocale, string>> = {
  ru: `Да, именно. Ты правильно заметил, что аватар двигается слишком часто. Но тут есть важный нюанс: частота — это не главная проблема.

На самом деле проблема в том, что жесты не связаны со смыслом. Почему так происходит? Потому что планировщик видит только громкость и интонацию, а не структуру фразы.

Есть три варианта, как это исправить.

1. Во-первых, можно просто снизить частоту жестов. Это быстро, но аватар станет деревянным.
2. Во-вторых, можно привязать жесты к паузам в речи. Это лучше, хотя паузы бывают и в середине мысли.
3. И наконец, можно читать текст ответа и понимать, где вопрос, где противопоставление, а где вывод.

Не совсем правильно думать, что третий вариант требует нейросети. Хватит словаря дискурсивных маркеров, если аккуратно обработать отрицания и границы слов. Например, «даже» не должно считаться согласием, а «так как» — это причина, а не «так».

**Главное: этого нельзя делать в лоб.** Если на каждое слово «но» запускать наклон головы, аватар будет выглядеть как марионетка. Обрати внимание, что большинство найденных сигналов должно заканчиваться ничем.

Поэтому я бы выбрал третий вариант, но с жёсткими ограничениями на частоту и повторы. Хочешь, я покажу, как это выглядит в коде?`,

  uk: `Так, саме так. Ти правильно помітив, що аватар рухається занадто часто. Але тут є важливий нюанс: частота — це не головна проблема.

Насправді проблема в тому, що жести не пов'язані зі змістом. Чому так відбувається? Тому що планувальник бачить лише гучність та інтонацію, а не структуру фрази.

Є три варіанти, як це виправити.

1. По-перше, можна просто зменшити частоту жестів. Це швидко, але аватар стане дерев'яним.
2. По-друге, можна прив'язати жести до пауз у мовленні. Це краще, хоча паузи бувають і посеред думки.
3. І нарешті, можна читати текст відповіді й розуміти, де питання, де протиставлення, а де висновок.

Не зовсім правильно думати, що третій варіант потребує нейромережі. Вистачить словника дискурсивних маркерів, якщо акуратно обробити заперечення та межі слів. Наприклад, «так як» — це причина, а не згода.

**Головне: цього не можна робити в лоб.** Якщо на кожне «але» запускати нахил голови, аватар виглядатиме як маріонетка. Зверніть увагу, що більшість знайдених сигналів мають закінчуватися нічим.

Отже, я б обрав третій варіант, але з жорсткими обмеженнями на частоту та повтори. Хочеш, я покажу, як це виглядає в коді?`,

  en: `Yes, exactly. You're right that the avatar moves too often. But there's an important nuance here: frequency isn't the real problem.

Actually, the problem is that the gestures aren't tied to meaning. Why does that happen? Because the scheduler only sees loudness and intonation, not the structure of the sentence.

There are three ways to fix it.

1. First, you can simply lower the gesture rate. It's quick, but the avatar turns wooden.
2. Second, you can tie gestures to pauses in speech. That's better, although pauses also happen in the middle of a thought.
3. Finally, you can read the text of the reply and see where there's a question, a contrast or a conclusion.

That's not quite right if you assume the third option needs a neural network. A dictionary of discourse markers is enough, as long as you handle negation and word boundaries carefully. For example, "correct implementation" is not agreement, and "move it to the right" is not "right".

**The key point: never do this naively.** If every "but" fires a head tilt, the avatar looks like a puppet. Keep in mind that most detected signals should end in nothing at all.

So I'd go with the third option, but with strict limits on frequency and repetition. Would you like me to show what it looks like in code?`,

  es: `Sí, exactamente. Tienes razón en que el avatar se mueve demasiado. Pero aquí hay un matiz importante: la frecuencia no es el problema real.

En realidad, el problema es que los gestos no están ligados al significado. ¿Por qué pasa esto? Porque el planificador solo ve el volumen y la entonación, no la estructura de la frase.

Hay tres formas de arreglarlo.

1. En primer lugar, se puede bajar la frecuencia de los gestos. Es rápido, pero el avatar se vuelve rígido.
2. En segundo lugar, se pueden atar los gestos a las pausas del habla. Es mejor, aunque también hay pausas en mitad de una idea.
3. Por último, se puede leer el texto de la respuesta y ver dónde hay una pregunta, un contraste o una conclusión.

No es correcto pensar que la tercera opción necesita una red neuronal. Basta con un diccionario de marcadores del discurso, si se tratan bien la negación y los límites de palabra. Por ejemplo, «no obstante» es un contraste, no un «no».

**Lo más importante: nunca hay que hacerlo a lo bruto.** Si cada «pero» dispara una inclinación de cabeza, el avatar parece una marioneta. Ten en cuenta que la mayoría de las señales detectadas no deberían producir nada.

Por eso yo elegiría la tercera opción, pero con límites estrictos de frecuencia y repetición. ¿Quieres que te muestre cómo se ve en código?`,
};
