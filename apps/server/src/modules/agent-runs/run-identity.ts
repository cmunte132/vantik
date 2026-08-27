import { randomInt } from 'node:crypto';

/**
 * A name for the agent working one issue, not for an account somebody manages.
 *
 * The identity is created on the first delegation of an issue and reused by
 * every attempt after it. It is never configured, listed or revoked by
 * anybody, so the name has one job: let a person read a handback at a glance
 * and see an agent rather than a uuid. "Fuzzy Zebra" does that.
 *
 * It used to name one run, which meant a fresh identity per delegation and
 * nothing ever reaping them. Two runs forced to overlap on one issue now share
 * this name — accepted, because the issue view renders a card per run and
 * every handback comment carries its own run id, so which run said what is
 * answerable without spending an identity to answer it.
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
 * 576 pairs, so two issues in the same feed colliding is unlikely but not
 * impossible — which is fine, because the name is a label and the identity's
 * id is the identifier. Nothing is keyed on it.
 */
export function runIdentityName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${
    ANIMALS[randomInt(ANIMALS.length)]
  }`;
}
