import { combos, type LocaleRules } from './RuleData';

const COUNTS = ['two', 'three', 'four', 'five', 'several', 'a few', 'a couple of', 'some key', 'a number of'];
const NOUNS = ['things', 'reasons', 'options', 'approaches', 'problems', 'points', 'ways', 'steps', 'issues', 'factors', 'questions', 'aspects', 'strategies', 'alternatives', 'tips', 'mistakes', 'rules', 'main reasons', 'key points', 'main points', 'main options', 'main approaches', 'possible approaches'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'next', 'final', 'last'];
const ITEM_NOUNS = ['point', 'reason', 'option', 'step', 'thing', 'approach', 'issue', 'factor', 'aspect', 'way'];

export const EN_RULES: LocaleRules = {
  locale: 'en',
  negators: ['not', 'no', 'never', 'hardly', 'barely', 'nothing'],
  groups: [
    // --- question (the `?` is the reliable signal; words only raise confidence) --------------------------------
    {
      kind: 'question',
      tier: 'weak',
      confidence: 0.35,
      phrases: [
        'what', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which', 'what if', 'why not', 'how about',
        'what about', 'do you', 'does it', 'does this', 'did you', 'did it', 'can you', 'could you', 'would you',
        'will you', 'should we', 'shall we', 'may i', 'might it', 'is it', 'is this', 'is that', 'are you', 'are we',
        'was it', 'were they', 'have you', 'has it', 'had you', 'are you sure', 'do you see', 'do you agree',
        'would that work', 'is that correct', 'isn\'t it', 'don\'t you', 'doesn\'t it', 'can i', 'should i',
        'how does', 'how do', 'how can', 'what\'s', 'why\'s', 'how\'s', 'is there', 'are there', 'do we', 'does that',
      ],
    },
    {
      // ChatGPT's closing offers and check-backs: questions even when the `?` comes late.
      kind: 'question',
      tier: 'weak',
      confidence: 0.55,
      phrases: [
        'would you like', 'do you want', 'want me to', 'shall i', 'should i show', 'what do you think',
        'does that make sense', 'does this make sense', 'does that help', 'would it help', 'any questions',
        'which one do you', 'which would you', 'how does that sound', 'sound good',
      ],
    },

    // --- enumeration -------------------------------------------------------------------------------------------
    {
      kind: 'enumeration',
      role: 'intro',
      tier: 'medium',
      position: 'any',
      confidence: 0.66,
      phrases: [
        ...combos(['there are', 'there are two', 'there are three', 'here are', 'here are two', 'here are three', 'we have', 'i see'], ['two', 'three', 'several', 'a few', 'a couple of']).filter(
          (p) => !/(two|three) (two|three|several|a few|a couple of)$/.test(p),
        ),
        ...combos(COUNTS, NOUNS),
        'the following', 'as follows', 'the main points are', 'the key points are', 'the main reasons are',
        'the options are', 'the steps are', 'we have several options', 'we have a few options', 'here\'s how',
        'here is how', 'step by step', 'let\'s break it down', 'let me break it down', 'let\'s go through',
        'broken down into', 'boils down to', 'falls into two', 'falls into three', 'comes down to',
      ],
    },
    {
      kind: 'enumeration',
      role: 'item',
      tier: 'strong',
      phrases: ['first of all', 'firstly', 'secondly', 'thirdly', 'fourthly', 'to begin with', 'for starters', 'to start with', 'on the one hand', 'step one', 'step two', 'step three'],
    },
    {
      kind: 'enumeration',
      role: 'item',
      tier: 'medium',
      phrases: [
        'first', 'second', 'third', 'fourth', 'fifth', 'next', 'another point', 'another reason', 'another option',
        'another thing', 'another way', 'another approach', 'in addition', 'additionally', 'on top of that',
        'the first', 'the second', 'the third', 'first up', 'to start',
        ...combos(['the'], combos(ORDINALS, ITEM_NOUNS)),
        ...combos(ORDINALS, ITEM_NOUNS),
      ],
    },
    { kind: 'enumeration', role: 'item', tier: 'weak', phrases: ['then', 'also', 'plus', 'moreover', 'furthermore', 'besides'] },
    {
      kind: 'enumeration',
      role: 'final',
      tier: 'strong',
      phrases: ['last but not least', 'lastly', 'and finally', 'and lastly', 'the final point', 'the last point', 'one last thing', 'one final thing', 'the last one'],
    },
    { kind: 'enumeration', role: 'final', tier: 'medium', phrases: ['finally', 'last'] },

    // --- contrast / qualification ------------------------------------------------------------------------------
    {
      kind: 'contrast',
      tier: 'strong',
      phrases: [
        'however', 'nevertheless', 'nonetheless', 'on the other hand', 'on the contrary', 'in contrast', 'by contrast',
        'that said', 'having said that', 'that being said', 'even so', 'the catch is', 'the caveat is',
        'the downside is', 'the problem is', 'the issue is', 'the limitation is', 'the trade-off is',
        'the tradeoff is', 'the only problem is', 'the only catch is', 'except that', 'with one exception',
        'although', 'even though', 'whereas', 'but there\'s a catch', 'but there is a catch', 'there\'s a catch',
        'there is a catch', 'one caveat', 'one exception', 'the flip side', 'the drawback is', 'conversely',
      ],
    },
    {
      kind: 'contrast',
      tier: 'medium',
      phrases: ['but', 'instead', 'at the same time', 'in practice', 'in reality', 'unlike', 'otherwise', 'on the flip side', 'mind you'],
    },
    { kind: 'contrast', tier: 'medium', position: 'any', phrases: ['rather than', 'instead of', 'except for', 'as opposed to', 'though'] },
    { kind: 'contrast', tier: 'weak', phrases: ['yet', 'still', 'while', 'actually', 'in fact', 'rather', 'except', 'alternatively', 'admittedly'] },
    { kind: 'contrast', tier: 'weak', position: 'any', phrases: ['not quite', 'not necessarily', 'not exactly'] },

    // --- conclusion / result / recommendation ------------------------------------------------------------------
    {
      kind: 'conclusion',
      tier: 'strong',
      phrases: [
        'in conclusion', 'to conclude', 'to sum up', 'to summarize', 'to summarise', 'in summary', 'in short',
        'all in all', 'the bottom line is', 'bottom line', 'my recommendation is', 'my recommendation would be',
        'i would recommend', 'i\'d recommend', 'i would choose', 'i\'d choose', 'i would go with', 'i\'d go with',
        'i would pick', 'i\'d pick', 'i would suggest', 'i\'d suggest', 'the best approach here is',
        'the best approach is', 'the best option is', 'the practical choice is', 'so i would', 'so i\'d',
        'therefore i would', 'long story short', 'in a nutshell', 'as a result', 'consequently', 'therefore',
        'thus', 'hence', 'to wrap up', 'to put it all together', 'the takeaway is', 'the short answer is',
        'my advice is', 'my advice would be', 'if i were you', 'the verdict',
      ],
    },
    {
      kind: 'conclusion',
      tier: 'medium',
      phrases: ['ultimately', 'overall', 'in the end', 'which means', 'this means', 'that means', 'so overall', 'in general', 'generally speaking', 'the key point is', 'the main point is', 'the answer is'],
    },
    { kind: 'conclusion', tier: 'weak', phrases: ['so', 'what matters is', 'the important thing is', 'basically'] },

    // --- agreement ---------------------------------------------------------------------------------------------
    {
      kind: 'agreement',
      tier: 'strong',
      negatable: true,
      phrases: [
        'that\'s right', 'that is right', 'that\'s correct', 'that is correct', 'that\'s exactly it',
        'that\'s it exactly', 'exactly right', 'you\'re right', 'you are right', 'you\'re absolutely right',
        'you are absolutely right', 'you\'re correct', 'you are correct', 'i agree', 'we agree', 'i completely agree',
        'i fully agree', 'that makes sense', 'that makes total sense', 'good point', 'fair point', 'great point',
        'that\'s true', 'that is true', 'yes, exactly', 'spot on', 'you got it', 'you\'ve got it', 'absolutely right',
        'that\'s a good point', 'that\'s a fair point', 'right on',
      ],
    },
    {
      kind: 'agreement',
      tier: 'medium',
      standalone: true,
      phrases: ['yes', 'exactly', 'precisely', 'absolutely', 'definitely', 'certainly', 'indeed', 'agreed', 'of course', 'correct', 'makes sense', 'that\'s it', 'true', 'totally'],
    },
    { kind: 'agreement', tier: 'weak', standalone: true, confidence: 0.6, phrases: ['yeah', 'yep', 'right', 'sure', 'okay', 'ok', 'fair enough', 'got it'] },

    // --- disagreement / correction -----------------------------------------------------------------------------
    {
      kind: 'disagreement',
      tier: 'strong',
      phrases: [
        'not exactly', 'not quite', 'not really', 'not necessarily', 'that\'s not correct', 'that is not correct',
        'that\'s incorrect', 'that is incorrect', 'that\'s not quite right', 'that\'s not right', 'that\'s not true',
        'that isn\'t true', 'that isn\'t correct', 'i disagree', 'i\'d disagree', 'i wouldn\'t say that',
        'i would not say that', 'i don\'t think so', 'quite the opposite', 'it\'s the opposite',
        'it\'s actually the opposite', 'that\'s not what', 'that\'s a misconception', 'that\'s a common misconception',
        'it\'s a myth', 'that\'s a myth', 'not at all', 'that\'s not how', 'it doesn\'t work that way',
        'that\'s not the case', 'that is not the case', 'it\'s not that simple', 'it\'s not so simple', 'actually, no',
        'no, actually', 'well, no',
      ],
    },
    { kind: 'disagreement', tier: 'medium', standalone: true, phrases: ['no', 'nope', 'incorrect', 'wrong', 'the opposite', 'on the contrary', 'that\'s different'] },
    { kind: 'disagreement', tier: 'medium', phrases: ['more precisely', 'to be precise', 'more accurately', 'strictly speaking', 'to be fair', 'to clarify', 'let me correct'] },
    { kind: 'disagreement', tier: 'weak', phrases: ['technically', 'actually, it\'s', 'in fact, it\'s'] },

    // --- emphasis ----------------------------------------------------------------------------------------------
    {
      kind: 'emphasis',
      tier: 'strong',
      negatable: true,
      phrases: [
        'most importantly', 'above all', 'the most important', 'crucially', 'critically important', 'it\'s crucial',
        'it is crucial', 'it\'s critical', 'this is critical', 'this is crucial', 'key takeaway', 'the key takeaway',
        'pay close attention', 'never ever', 'under no circumstances', 'whatever you do',
      ],
    },
    {
      kind: 'emphasis',
      tier: 'medium',
      negatable: true,
      phrases: [
        'important', 'importantly', 'crucial', 'critical', 'essential', 'vital', 'key point', 'the key point',
        'the main thing', 'the main point', 'the important part', 'the interesting part', 'the crucial part',
        'the tricky part', 'especially', 'particularly', 'notably', 'keep in mind', 'bear in mind', 'note that',
        'notice that', 'worth noting', 'worth mentioning', 'it\'s worth noting', 'one thing to note',
        'the point is', 'what matters is', 'what really matters', 'fundamentally', 'make sure', 'be careful',
        'pay attention', 'remember', 'don\'t forget', 'in particular', 'the key is', 'the trick is',
        'the key point is', 'the main point is', 'the important thing is',
      ],
    },
    {
      kind: 'emphasis',
      tier: 'weak',
      negatable: true,
      confidence: 0.42,
      phrases: ['key', 'the key', 'main', 'really', 'very', 'significantly', 'seriously', 'truly', 'definitely', 'huge', 'massive'],
    },
    // Imperatives and modal certainty: everywhere in advice, weak on purpose (they aggregate, never trigger alone).
    { kind: 'emphasis', tier: 'weak', confidence: 0.42, phrases: ['do not', 'don\'t', 'never', 'always', 'must', 'need to', 'have to', 'should never', 'you must'] },

    // --- modifiers ---------------------------------------------------------------------------------------------
    { kind: 'example', tier: 'medium', phrases: ['for example', 'for instance', 'e.g.', 'let\'s say', 'say you', 'suppose', 'imagine', 'consider', 'picture this', 'as an example'] },
    { kind: 'example', tier: 'medium', position: 'any', phrases: ['such as', 'for example', 'for instance', 'like when'] },
    { kind: 'cause', tier: 'medium', position: 'any', phrases: ['because', 'due to', 'the reason is', 'that\'s because', 'this is because', 'since', 'as a result of', 'thanks to', 'owing to'] },
    { kind: 'clarification', tier: 'medium', position: 'any', phrases: ['in other words', 'that is', 'i.e.', 'meaning', 'more specifically', 'specifically', 'to put it simply', 'simply put', 'put simply', 'that is to say'] },

    // --- neutral spans that shadow shorter markers -------------------------------------------------------------
    {
      kind: 'none',
      tier: 'weak',
      phrases: [
        'but also', 'not only', 'right now', 'right away', 'right here', 'right after', 'right before', 'right side',
        'to the right', 'the right', 'sure that', 'no longer', 'no one', 'no matter', 'no need', 'no problem',
        'so that', 'so far', 'so much', 'so many', 'so on', 'and so on', 'first time', 'the first time',
        'at first', 'last time', 'last year', 'last week', 'at last', 'next time', 'next to',
        'true or false', 'yes or no', 'still life', 'still image',
      ],
    },
  ],
};
