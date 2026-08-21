const adjectives = [
  "absurd", "bouncy", "breezy", "bubbly", "cheeky", "cosmic", "crispy", "dapper",
  "dizzy", "dorky", "dreamy", "fancy", "fizzy", "floppy", "fluffy", "funky",
  "fuzzy", "giggly", "goofy", "groovy", "grumpy", "happy", "hasty", "jazzy",
  "jolly", "kooky", "lazy", "lucky", "merry", "mighty", "minty", "muddy",
  "nosy", "peppy", "perky", "pesky", "plucky", "poky", "punchy", "quirky",
  "rowdy", "rusty", "salty", "sassy", "sleepy", "sneaky", "snazzy", "speedy",
  "spicy", "splashy", "springy", "squishy", "sunny", "tipsy", "tricky", "wacky",
  "wavy", "wiggly", "wobbly", "woolly", "zany", "zesty", "zippy", "zoomy",
] as const;

const characters = [
  "alpaca", "badger", "bandit", "beagle", "beetle", "blob", "bunny", "cactus",
  "captain", "catfish", "chicken", "cowboy", "crab", "dragon", "duckling", "ferret",
  "flamingo", "ghost", "goblin", "goose", "gremlin", "guppy", "hamster", "hippo",
  "llama", "lobster", "magician", "marmot", "monkey", "moose", "muffin", "narwhal",
  "noodle", "otter", "panda", "parrot", "penguin", "pickle", "pigeon", "pirate",
  "pony", "poodle", "puppet", "raccoon", "robot", "salamander", "shrimp", "sloth",
  "snail", "squirrel", "toaster", "troll", "turkey", "turtle", "unicorn", "walrus",
  "weasel", "wizard", "wombat", "yak", "yeti", "zebra", "bear", "biscuit",
] as const;

const things = [
  "accordion", "anvil", "bagel", "balloon", "banjo", "bean", "blanket", "burrito",
  "button", "cabbage", "confetti", "crayon", "disco", "donut", "doodle", "drum",
  "dumpling", "elbow", "fanfare", "fez", "fiddle", "flannel", "frisbee", "glitter",
  "gravy", "hammock", "kazoo", "ketchup", "lasagna", "marshmallow", "mitten", "nacho",
  "pancake", "pillow", "pizza", "popcorn", "pretzel", "pudding", "puzzle", "ravioli",
  "rocket", "sandwich", "slipper", "spam", "sparkle", "spoon", "sprout", "sticker",
  "taco", "teacup", "thunder", "trumpet", "turnip", "waffle", "whisker", "whoopee",
  "yoink", "zucchini", "bonnet", "bucket", "cupcake", "mustard", "scooter", "sundae",
] as const;

export function makeTableName(): string {
  const random = new Uint8Array(3);
  crypto.getRandomValues(random);
  return [
    adjectives[random[0]! % adjectives.length],
    characters[random[1]! % characters.length],
    things[random[2]! % things.length],
  ].join("-");
}
