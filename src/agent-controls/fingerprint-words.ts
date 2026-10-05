/**
 * The 256 words that turn a public key into something a person can compare
 * across two screens. Copied verbatim from budgetarc
 * `services/deviceLink/fingerprintWords.ts`; the phone shows the same four
 * words when it connects this machine. `FINGERPRINT_WORDS_CHECKSUM` is the
 * first 16 hex of SHA-256 over the list serialised as compact JSON, and both
 * sides test against it. Never edit this in place.
 */
export const FINGERPRINT_WORDS: readonly string[] = [
  'acorn', 'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'aurora',
  'badge', 'bamboo', 'banjo', 'barley', 'basil', 'beacon', 'beetle', 'berry',
  'birch', 'bison', 'blaze', 'bloom', 'bluff', 'bolt', 'bonsai', 'boulder',
  'breeze', 'brick', 'bridge', 'brook', 'bubble', 'cabin', 'cactus', 'camel',
  'candle', 'canoe', 'canyon', 'carbon', 'cargo', 'cedar', 'cello', 'chalk',
  'cherry', 'cider', 'cinder', 'citrus', 'clover', 'cobalt', 'comet', 'copper',
  'coral', 'cosmos', 'cotton', 'crane', 'crater', 'crystal', 'cypress', 'daisy',
  'delta', 'desert', 'dingo', 'dolphin', 'dove', 'dragon', 'drift', 'dune',
  'eagle', 'echo', 'ember', 'emerald', 'falcon', 'fern', 'fiddle', 'fig',
  'finch', 'fjord', 'flame', 'flint', 'forest', 'fossil', 'fox', 'galaxy',
  'garnet', 'geyser', 'ginger', 'glacier', 'globe', 'granite', 'grape', 'gravel',
  'harbor', 'hazel', 'heron', 'hollow', 'honey', 'hornet', 'husky', 'iris',
  'island', 'ivory', 'jasmine', 'jade', 'jaguar', 'jelly', 'jungle', 'juniper',
  'kayak', 'kelp', 'kettle', 'kiwi', 'koala', 'lagoon', 'lantern', 'larch',
  'lava', 'lemon', 'lilac', 'lily', 'linen', 'lotus', 'lunar', 'lynx',
  'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mesa', 'meteor',
  'mint', 'mirror', 'moose', 'moss', 'nectar', 'nebula', 'needle', 'nutmeg',
  'oak', 'oasis', 'ocean', 'olive', 'onyx', 'opal', 'orbit', 'orchid',
  'otter', 'owl', 'oyster', 'paddle', 'palm', 'panda', 'paper', 'parrot',
  'peach', 'pebble', 'pepper', 'pine', 'planet', 'plum', 'polar', 'pollen',
  'poppy', 'prism', 'pumpkin', 'quartz', 'quill', 'rabbit', 'radar', 'raven',
  'reef', 'ridge', 'river', 'robin', 'rocket', 'rose', 'ruby', 'saffron',
  'sage', 'salmon', 'sapphire', 'satin', 'scarlet', 'sequoia', 'shadow', 'shell',
  'sierra', 'silver', 'sparrow', 'spruce', 'squid', 'star', 'stone', 'storm',
  'summit', 'sunset', 'swan', 'tango', 'thistle', 'thunder', 'tiger', 'timber',
  'topaz', 'torch', 'tulip', 'tundra', 'turtle', 'valley', 'velvet', 'violet',
  'walnut', 'walrus', 'willow', 'window', 'winter', 'wolf', 'yarrow', 'zebra',
  'zenith', 'zephyr', 'basalt', 'beryl', 'bramble', 'cashew', 'cobra', 'dahlia',
  'elm', 'ferret', 'gecko', 'gull', 'heather', 'indigo', 'iguana', 'jackal',
  'lark', 'lichen', 'lupine', 'mallow', 'marsh', 'nickel', 'orca', 'osprey',
  'petal', 'pixel', 'puffin', 'quince', 'rain', 'saddle', 'sable', 'tapir',
  'tidal', 'umber', 'vapor', 'wren', 'yucca', 'zinnia', 'hawk', 'bear',
];

export const FINGERPRINT_WORDS_CHECKSUM = '343dd3140eed5dd7';
