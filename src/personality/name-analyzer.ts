/**
 * Silly token name detection for roasting purposes
 */

export type SillyCategory =
  | 'food'      // PIZZA, BURGER, TACO
  | 'animal'    // DOGE variants, CAT, PEPE
  | 'pump'      // MOON, ROCKET, 100X, SAFE
  | 'celebrity' // ELON, TRUMP
  | 'copycat'   // anything with INU, PEPE suffix
  | 'random'    // gibberish letters
  | 'crude';    // profanity/sexual

/**
 * Detect if a token has a silly/memey name worth roasting
 * @param symbol Token symbol (e.g., "BURGER")
 * @param name Token name (e.g., "BurgerCoin")
 * @returns Category of silliness or null if normal
 */
export function detectSillyName(symbol: string, name: string): SillyCategory | null {
  const s = symbol.toUpperCase();
  const n = name.toLowerCase();

  // Food tokens - who's funding these, DoorDash?
  if (/^(PIZZA|BURGER|TACO|SUSHI|BACON|FRIES|HOTDOG|HOT ?DOG|RAMEN|STEAK|NOODLE|CHEESE|BREAD|COOKIE|DONUT|WAFFLE|PANCAKE|CHICKEN|NUGGET|FROG ?LEGS|SOUP|SALAD)/.test(s) ||
      /pizza|burger|taco|sushi|bacon|fries|hotdog|ramen|steak|noodle|food|eat|hungry|yummy|delicious/i.test(n)) {
    return 'food';
  }

  // Copycat tokens - they literally just added INU/PEPE/DOGE to something
  if (/INU$|PEPE$|DOGE$|SHIB$|FLOKI$|BONK$/.test(s) && s.length > 6) {
    return 'copycat';
  }

  // Animal memes - DOGE already happened
  if (/^(SHIB|FLOKI|DOGE|BONK|PEPE|APE|CAT|DOG|FROG|MONKEY|BEAR|BULL|WHALE|FISH|BIRD|DUCK|HAMSTER|RABBIT|PIG|COW|GOAT)/.test(s) ||
      /shiba|doge|pepe|ape|monkey|animal|zoo/i.test(n)) {
    return 'animal';
  }

  // Obvious pump schemes - very subtle naming
  if (/^(MOON|ROCKET|SAFE|100X|1000X|10000X|LAMBO|RICH|PUMP|GAINS|PROFIT|DIAMOND|GEM|GOLD|WEALTH|MILLION|BILLION)/.test(s) ||
      /to.?the.?moon|going.?up|cant.?stop|wont.?stop|guaranteed|get.?rich|easy.?money|free.?money/i.test(n)) {
    return 'pump';
  }

  // Celebrity grift - riding famous names
  if (/^(ELON|TRUMP|MUSK|BIDEN|OBAMA|KANYE|DRAKE|SNOOP|JEFF|BEZOS|ZUCK|GATES|BUFFET|VITALIK)/.test(s) ||
      /elon|trump|musk|biden|obama|kanye|celebrity|famous/i.test(n)) {
    return 'celebrity';
  }

  // Random gibberish (4+ consonants in a row with no vowels)
  if (/^[BCDFGHJKLMNPQRSTVWXYZ]{4,}$/.test(s)) {
    return 'random';
  }

  // Crude/profanity tokens
  const crudePatterns = /^(ASS|BOOB|PORN|SEX|NUDE|MILF|DILDO|COCK|DICK|PUSSY|FUCK|SHIT|CUM|HORNY)/;
  if (crudePatterns.test(s) ||
      /nsfw|adult|xxx|18\+|sexy|erotic/i.test(n)) {
    return 'crude';
  }

  // Not particularly silly
  return null;
}

/**
 * Get a human-readable description of the silly category
 */
export function getSillyCategoryDescription(category: SillyCategory): string {
  const descriptions: Record<SillyCategory, string> = {
    food: 'a food token',
    animal: 'another animal coin',
    pump: 'an obvious pump scheme name',
    celebrity: 'celebrity grift',
    copycat: 'a copycat token',
    random: 'random gibberish letters',
    crude: 'a crude/NSFW name',
  };
  return descriptions[category];
}
