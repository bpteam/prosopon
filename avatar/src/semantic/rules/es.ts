import { combos, type LocaleRules } from './RuleData';

const F_NOUNS = ['cosas', 'razones', 'opciones', 'formas', 'maneras', 'ideas', 'claves', 'preguntas', 'estrategias', 'alternativas', 'ventajas', 'desventajas', 'reglas', 'etapas'];
const M_NOUNS = ['enfoques', 'problemas', 'puntos', 'pasos', 'factores', 'aspectos', 'motivos', 'métodos', 'caminos', 'errores', 'consejos', 'escenarios'];
const F_ITEM = ['razón', 'opción', 'cosa', 'idea', 'forma', 'ventaja', 'clave'];
const M_ITEM = ['punto', 'paso', 'aspecto', 'factor', 'motivo', 'enfoque', 'consejo', 'problema'];

export const ES_RULES: LocaleRules = {
  locale: 'es',
  negators: ['no', 'nunca', 'ni', 'tampoco', 'jamás'],
  groups: [
    // --- question (plus the structural ¿ … ?) ----------------------------------------------------------------
    {
      kind: 'question',
      tier: 'weak',
      confidence: 0.35,
      phrases: [
        'qué', 'por qué', 'para qué', 'cómo', 'cuándo', 'dónde', 'adónde', 'de dónde', 'quién', 'quiénes', 'cuál',
        'cuáles', 'cuánto', 'cuántos', 'cuántas', 'qué pasa si', 'por qué no', 'qué tal si', 'qué hay de',
        'puedes', 'podrías', 'podemos', 'deberíamos', 'quieres', 'quiere', 'tiene sentido', 'estás seguro',
        'estás segura', 'está seguro', 'están seguros', 'acaso', 'y si',
      ],
    },
    {
      kind: 'question',
      tier: 'weak',
      confidence: 0.55,
      phrases: ['qué te parece', 'qué opinas', 'te gustaría', 'le gustaría', 'quieres que', 'prefieres', 'te ayudo con', 'te muestro', 'te explico', 'alguna duda', 'qué piensas'],
    },

    // --- enumeration -------------------------------------------------------------------------------------------
    {
      kind: 'enumeration',
      role: 'intro',
      tier: 'medium',
      position: 'any',
      confidence: 0.66,
      phrases: [
        ...combos(['dos', 'tres', 'cuatro', 'cinco', 'varias', 'algunas', 'unas cuantas'], F_NOUNS),
        ...combos(['dos', 'tres', 'cuatro', 'cinco', 'varios', 'algunos', 'unos cuantos'], M_NOUNS),
        'hay dos', 'hay tres', 'hay varios', 'hay varias', 'hay algunos', 'hay algunas', 'los siguientes',
        'las siguientes', 'lo siguiente', 'los puntos principales', 'los puntos clave', 'las razones principales',
        'las claves son', 'tenemos varias opciones', 'tienes varias opciones', 'podemos distinguir', 'aquí tienes',
        'estos son', 'estas son', 'paso a paso', 'vamos por partes', 'por partes', 'se reduce a', 'se divide en',
      ],
    },
    {
      kind: 'enumeration',
      role: 'item',
      tier: 'strong',
      phrases: ['en primer lugar', 'en segundo lugar', 'en tercer lugar', 'en cuarto lugar', 'para empezar', 'para comenzar', 'primeramente', 'por un lado', 'paso uno', 'paso dos'],
    },
    {
      kind: 'enumeration',
      role: 'item',
      tier: 'medium',
      phrases: [
        'primero', 'segundo', 'tercero', 'a continuación', 'además', 'asimismo',
        ...combos(['el primer', 'el segundo', 'el tercer', 'el siguiente', 'otro'], M_ITEM),
        ...combos(['la primera', 'la segunda', 'la tercera', 'la siguiente', 'otra'], F_ITEM),
      ],
    },
    { kind: 'enumeration', role: 'item', tier: 'weak', phrases: ['después', 'luego', 'también', 'cuarto', 'y luego'] },
    {
      kind: 'enumeration',
      role: 'final',
      tier: 'strong',
      phrases: ['por último', 'en último lugar', 'y por último', 'y finalmente', 'para terminar', 'para acabar', ...combos(['el último'], M_ITEM), ...combos(['la última'], F_ITEM)],
    },
    { kind: 'enumeration', role: 'final', tier: 'medium', phrases: ['finalmente', 'lo último'] },

    // --- contrast / qualification ------------------------------------------------------------------------------
    {
      kind: 'contrast',
      tier: 'strong',
      phrases: [
        'sin embargo', 'no obstante', 'aun así', 'aún así', 'por otro lado', 'por otra parte', 'en contraste',
        'a diferencia de', 'en cambio', 'mientras que', 'con una excepción', 'el problema es', 'el problema está en',
        'el inconveniente es', 'la limitación es', 'el matiz es', 'hay un matiz', 'el truco está en', 'dicho esto',
        'dicho eso', 'eso sí', 'ahora bien', 'pero hay un problema', 'pero hay un matiz', 'la pega es', 'aunque',
        'si bien', 'a pesar de', 'pese a',
      ],
    },
    {
      kind: 'contrast',
      tier: 'medium',
      phrases: ['pero', 'al mismo tiempo', 'en la práctica', 'en realidad', 'al contrario', 'la cuestión es', 'de lo contrario', 'con todo'],
    },
    { kind: 'contrast', tier: 'medium', position: 'any', phrases: ['en lugar de', 'en vez de', 'excepto', 'salvo', 'a diferencia de'] },
    { kind: 'contrast', tier: 'weak', phrases: ['de hecho', 'más bien', 'todavía', 'aun'] },
    { kind: 'contrast', tier: 'weak', position: 'any', phrases: ['no exactamente', 'no necesariamente', 'no del todo', 'no siempre'] },

    // --- conclusion --------------------------------------------------------------------------------------------
    {
      kind: 'conclusion',
      tier: 'strong',
      phrases: [
        'por tanto', 'por lo tanto', 'por consiguiente', 'en consecuencia', 'como resultado', 'en conclusión',
        'para concluir', 'para resumir', 'resumiendo', 'en resumen', 'en pocas palabras', 'en definitiva',
        'en síntesis', 'la conclusión es', 'mi recomendación es', 'mi recomendación sería', 'mi consejo es',
        'yo recomendaría', 'te recomendaría', 'le recomendaría', 'yo elegiría', 'yo optaría', 'yo me quedaría con',
        'la opción práctica es', 'lo mejor aquí es', 'lo más práctico es', 'la mejor opción es', 'por eso yo',
        'por tanto yo', 'si yo fuera tú', 'yo que tú', 'en resumidas cuentas', 'a fin de cuentas',
      ],
    },
    {
      kind: 'conclusion',
      tier: 'medium',
      phrases: ['así que', 'esto significa', 'eso significa', 'lo que significa', 'en conjunto', 'al final', 'por eso', 'recomendaría', 'elegiría', 'el punto clave es', 'la idea principal es', 'la respuesta es', 'lo más sensato'],
    },
    { kind: 'conclusion', tier: 'weak', confidence: 0.4, phrases: ['en general', 'entonces', 'total', 'en fin', 'lo importante es', 'básicamente'] },

    // --- agreement ---------------------------------------------------------------------------------------------
    {
      kind: 'agreement',
      tier: 'strong',
      negatable: true,
      phrases: [
        'eso es correcto', 'así es', 'es cierto', 'es verdad', 'estoy de acuerdo', 'estoy totalmente de acuerdo',
        'tienes razón', 'tiene razón', 'tenéis razón', 'tienen razón', 'tienes toda la razón', 'eso tiene sentido',
        'claro que sí', 'exactamente eso', 'buena observación', 'buen punto', 'lo has entendido bien',
        'lo entendiste bien', 'sí, exacto', 'sí, exactamente', 'totalmente cierto', 'correctísimo',
      ],
    },
    {
      kind: 'agreement',
      tier: 'medium',
      standalone: true,
      phrases: ['sí', 'exactamente', 'exacto', 'precisamente', 'correcto', 'absolutamente', 'definitivamente', 'sin duda', 'efectivamente', 'de acuerdo', 'tiene sentido', 'por supuesto', 'desde luego', 'eso es', 'justamente', 'claro', 'totalmente'],
    },
    { kind: 'agreement', tier: 'weak', standalone: true, confidence: 0.6, phrases: ['cierto', 'vale', 'bien', 'perfecto', 'ok', 'venga'] },

    // --- disagreement / correction -----------------------------------------------------------------------------
    {
      kind: 'disagreement',
      tier: 'strong',
      phrases: [
        'no exactamente', 'no del todo', 'no realmente', 'no necesariamente', 'eso no es correcto', 'eso es incorrecto',
        'no es correcto', 'no es así', 'eso no es así', 'en realidad no', 'no estoy de acuerdo', 'yo no diría eso',
        'no diría eso', 'todo lo contrario', 'justo lo contrario', 'es un mito', 'eso es un mito', 'es un error común',
        'es un malentendido', 'no es tan simple', 'no es tan sencillo', 'claro que no', 'para nada', 'en absoluto',
      ],
    },
    { kind: 'disagreement', tier: 'medium', standalone: true, phrases: ['no', 'incorrecto', 'al contrario', 'eso no es', 'es diferente', 'no siempre'] },
    { kind: 'disagreement', tier: 'medium', phrases: ['más precisamente', 'para ser precisos', 'para ser exactos', 'mejor dicho', 'estrictamente hablando', 'hay que matizar', 'matizo'] },
    { kind: 'disagreement', tier: 'weak', phrases: ['técnicamente'] },

    // --- emphasis ----------------------------------------------------------------------------------------------
    {
      kind: 'emphasis',
      tier: 'strong',
      negatable: true,
      phrases: [
        'lo más importante', 'muy importante', 'sumamente importante', 'es fundamental', 'es crucial', 'es clave',
        'ten en cuenta', 'tenga en cuenta', 'tened en cuenta', 'tengan en cuenta', 'hay que destacar', 'cabe destacar',
        'cabe señalar', 'en ningún caso', 'bajo ningún concepto', 'quiero subrayar', 'subrayo',
      ],
    },
    {
      kind: 'emphasis',
      tier: 'medium',
      negatable: true,
      phrases: [
        'importante', 'lo importante', 'punto clave', 'crítico', 'crucial', 'esencial', 'fundamental', 'lo principal',
        'la idea principal', 'sobre todo', 'fíjate', 'fíjese', 'nota que', 'el punto importante',
        'el punto interesante', 'el punto crítico', 'ante todo', 'fundamentalmente', 'la cuestión es',
        'lo que importa es', 'recuerda', 'recuerde', 'asegúrate', 'asegúrese', 'ojo', 'cuidado', 'no olvides',
        'no olvide', 'vale la pena', 'conviene',
      ],
    },
    { kind: 'emphasis', tier: 'weak', negatable: true, phrases: ['clave', 'principal', 'especialmente', 'particularmente', 'observa', 'observe', 'realmente', 'significativamente', 'muy', 'enorme'] },
    { kind: 'emphasis', tier: 'weak', confidence: 0.42, phrases: ['no debes', 'nunca', 'siempre', 'hay que', 'debe', 'debes', 'es necesario', 'tienes que'] },

    // --- modifiers ---------------------------------------------------------------------------------------------
    { kind: 'example', tier: 'medium', position: 'any', phrases: ['por ejemplo', 'como ejemplo', 'supongamos', 'imagina', 'imagine', 'pongamos que', 'digamos', 'pongamos por caso', 'un ejemplo'] },
    { kind: 'cause', tier: 'medium', position: 'any', phrases: ['porque', 'ya que', 'debido a', 'la razón es', 'puesto que', 'dado que', 'gracias a', 'a causa de'] },
    { kind: 'clarification', tier: 'medium', position: 'any', phrases: ['en otras palabras', 'es decir', 'o sea', 'más concretamente', 'concretamente', 'dicho de otro modo', 'dicho de otra forma'] },

    // --- neutral spans -----------------------------------------------------------------------------------------
    {
      kind: 'none',
      tier: 'weak',
      phrases: [
        'sino también', 'no solo', 'no sólo', 'no solamente', 'no hay', 'no tiene', 'no es necesario', 'no puedes',
        'no se', 'no me', 'no te', 'no lo', 'no la', 'claro que', 'así como', 'así que no', 'más o menos',
        'bien sea',
      ],
    },
  ],
};
