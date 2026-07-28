import { Agents } from './agents';
import { CreateNewProduct } from './create-new-product';
import { CreateNewTeam } from './create-new-team';
import { Export } from './export';
import { Labels } from './labels';
import { Members } from './members';
import { Overview } from './overview';

// A product and a team are the two axes of a workspace, so the form that makes
// one is the form that makes the other. Only the create forms are here. To
// read a product, and to change it, stays on the product page beside the
// modules it owns.
export const SECTION_COMPONENTS = {
  overview: Overview,
  labels: Labels,
  members: Members,
  agents: Agents,
  new_team: CreateNewTeam,
  new_product: CreateNewProduct,
  export: Export,
};

export const SECTION_TITLES = {
  overview: 'Overview',
  labels: 'Labels',
  members: 'Members',
  agents: 'Agents',
  new_team: 'Add team',
  new_product: 'Add product',
  export: 'Export',
};

type StringKeys<T> = {
  [K in keyof T]: T[K] extends string ? K : never;
}[keyof T];

export type SECTION_COMPONENTS_KEYS = StringKeys<typeof SECTION_COMPONENTS>;
