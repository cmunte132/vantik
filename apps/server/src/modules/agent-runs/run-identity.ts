import { randomInt } from 'node:crypto';

/**
 * A name for one execution, not for an account somebody manages.
 *
 * A hosted run is handed to an identity that exists for the length of that run
 * and is never configured, listed or revoked by anybody — so the name only has
 * to do one job: let a person tell two runs apart in a comment feed at a
 * glance. "Fuzzy Zebra" does that; a uuid does not, and reusing one account
 * for every run makes three concurrent handbacks indistinguishable.
 *
 * Deliberately harmless words. These end up authoring comments on real issues,
 * so the list contains nothing that could read as rude, cute-but-confusing, or
 * as a real person's name.
 */
const ADJECTIVES = [
  'Amber',
  'Brisk',
  'Calm',
  'Clever',
  'Copper',
  'Dapper',
  'Eager',
  'Fuzzy',
  'Gentle',
  'Humble',
  'Jolly',
  'Keen',
  'Lucky',
  'Mellow',
  'Nimble',
  'Patient',
  'Quiet',
  'Rapid',
  'Sunny',
  'Tidy',
  'Upbeat',
  'Vivid',
  'Witty',
  'Zesty',
];

const ANIMALS = [
  'Badger',
  'Beaver',
  'Bison',
  'Cormorant',
  'Dolphin',
  'Falcon',
  'Gecko',
  'Heron',
  'Ibis',
  'Jackal',
  'Kestrel',
  'Lemur',
  'Marten',
  'Newt',
  'Otter',
  'Panther',
  'Quail',
  'Raven',
  'Seal',
  'Tapir',
  'Urchin',
  'Vulture',
  'Walrus',
  'Zebra',
];

/**
 * 576 pairs, so two runs in the same feed colliding is unlikely but not
 * impossible — which is fine, because the name is a label and the run id is
 * the identifier. Nothing is keyed on it.
 */
export function runIdentityName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${
    ANIMALS[randomInt(ANIMALS.length)]
  }`;
}
